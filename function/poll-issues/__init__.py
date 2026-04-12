"""Squad Issue Poller — Azure Function (Timer Trigger)

Polls GitHub for issues labeled 'squad' that are ready for agent pickup.
Enqueues one message per issue to the Storage Queue for KEDA scaling.
"""

import json
import logging
import os

import azure.functions as func
import requests


def main(timer: func.TimerRequest, msg: func.Out[func.QueueMessage]) -> None:
    if timer.past_due:
        logging.warning("Timer is past due — running anyway")

    github_token = os.environ["GITHUB_TOKEN"]
    github_repo = os.environ["GITHUB_REPO"]
    squad_labels = os.environ.get("SQUAD_LABELS", "squad")

    owner, repo = github_repo.split("/")

    # Fetch open issues with 'squad' label but no 'squad:*' assignment label
    issues = fetch_unassigned_squad_issues(owner, repo, squad_labels, github_token)

    if not issues:
        logging.info("No unassigned squad issues found")
        return

    logging.info(f"Found {len(issues)} unassigned squad issue(s)")

    messages = []
    for issue in issues:
        message = {
            "issue_number": issue["number"],
            "title": issue["title"],
            "labels": [l["name"] for l in issue["labels"]],
            "repo": github_repo,
        }
        messages.append(json.dumps(message))
        logging.info(f"Enqueued issue #{issue['number']}: {issue['title']}")

    # Send all messages to the queue
    for m in messages:
        msg.set(m)


def fetch_unassigned_squad_issues(
    owner: str, repo: str, label: str, token: str
) -> list:
    """Fetch GitHub issues that have the squad label but no squad:{member} assignment."""
    url = f"https://api.github.com/repos/{owner}/{repo}/issues"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    params = {
        "labels": label,
        "state": "open",
        "per_page": 50,
        "sort": "created",
        "direction": "asc",
    }

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    all_issues = response.json()

    # Filter out issues already assigned to a squad member (has squad:* label)
    unassigned = []
    for issue in all_issues:
        label_names = [l["name"] for l in issue["labels"]]
        has_assignment = any(l.startswith("squad:") for l in label_names)
        if not has_assignment:
            unassigned.append(issue)

    return unassigned
