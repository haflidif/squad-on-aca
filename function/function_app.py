"""Squad Issue Poller — Azure Function (v2 Timer Trigger)

Polls GitHub for issues with squad:{member} labels (triaged by Ralph).
Enqueues one message per issue to Storage Queue for KEDA-scaled agent jobs.
Issues without a squad:{member} label are skipped — they haven't been triaged yet.
"""

import json
import logging
import os
import re
from typing import Optional

import azure.functions as func
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

app = func.FunctionApp()

logger = logging.getLogger("squad.poll_issues")

SQUAD_LABEL_PATTERN = re.compile(r"^squad:(.+)$")
GITHUB_API_BASE = "https://api.github.com"


def _build_session() -> requests.Session:
    """Build a requests session with retry and backoff for GitHub API rate limits."""
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[403, 429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    return session


def _extract_agent_type(labels: list[dict]) -> Optional[str]:
    """Extract agent_type from squad:{member} label. Returns None if no match."""
    for label in labels:
        match = SQUAD_LABEL_PATTERN.match(label["name"])
        if match:
            return match.group(1)
    return None


def _fetch_triaged_issues(
    session: requests.Session,
    owner: str,
    repo: str,
    token: str,
) -> list[dict]:
    """Fetch open GitHub issues that have a squad:{member} label (triaged).

    Handles pagination to retrieve all matching issues.
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/issues"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    params = {
        "state": "open",
        "per_page": 100,
        "sort": "created",
        "direction": "asc",
        "page": 1,
    }

    all_issues = []
    while True:
        response = session.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()

        remaining = response.headers.get("X-RateLimit-Remaining")
        if remaining is not None:
            logger.info("GitHub API rate limit remaining: %s", remaining)
            if int(remaining) < 10:
                logger.warning("GitHub API rate limit running low: %s remaining", remaining)

        page_issues = response.json()
        if not page_issues:
            break

        all_issues.extend(page_issues)

        # Stop if no next page
        if "next" not in response.links:
            break
        params["page"] += 1

    # Keep only issues with a squad:{member} label
    triaged = []
    for issue in all_issues:
        if issue.get("pull_request"):
            continue  # skip PRs (GitHub API returns them as issues too)
        agent_type = _extract_agent_type(issue["labels"])
        if agent_type:
            triaged.append({"issue": issue, "agent_type": agent_type})

    return triaged


@app.timer_trigger(
    schedule="0 */1 * * * *",
    arg_name="timer",
    run_on_startup=False,
)
@app.queue_output(
    arg_name="msg",
    queue_name="%SQUAD_QUEUE_NAME%",
    connection="AzureWebJobsStorage",
)
def poll_issues(timer: func.TimerRequest, msg: func.Out[list[str]]) -> None:
    """Poll GitHub issues and enqueue triaged ones for agent processing."""
    if timer.past_due:
        logger.warning("Timer trigger is past due — running anyway")

    github_token = os.environ.get("GITHUB_TOKEN")
    if not github_token:
        logger.error("GITHUB_TOKEN environment variable is not set")
        return

    github_repo = os.environ.get("GITHUB_REPO")
    if not github_repo:
        logger.error("GITHUB_REPO environment variable is not set")
        return

    parts = github_repo.split("/")
    if len(parts) != 2:
        logger.error("GITHUB_REPO must be in 'owner/repo' format, got: %s", github_repo)
        return

    owner, repo = parts

    session = _build_session()

    try:
        triaged = _fetch_triaged_issues(session, owner, repo, github_token)
    except requests.exceptions.RequestException as exc:
        logger.error("Failed to fetch issues from GitHub: %s", exc)
        return

    if not triaged:
        logger.info("No triaged squad issues found")
        return

    logger.info("Found %d triaged issue(s) with squad:{member} labels", len(triaged))

    # Deduplicate by issue number within this invocation
    seen: set[int] = set()
    messages: list[str] = []

    for entry in triaged:
        issue = entry["issue"]
        issue_number = issue["number"]

        if issue_number in seen:
            logger.debug("Skipping duplicate issue #%d", issue_number)
            continue
        seen.add(issue_number)

        message = {
            "issue_number": issue_number,
            "agent_type": entry["agent_type"],
            "repo": github_repo,
            "title": issue["title"],
        }
        messages.append(json.dumps(message))
        logger.info(
            "Enqueuing issue #%d → agent_type=%s: %s",
            issue_number,
            entry["agent_type"],
            issue["title"],
        )

    msg.set(messages)
    logger.info("Enqueued %d message(s) to squad queue", len(messages))
