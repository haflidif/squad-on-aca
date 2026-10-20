// Shared by orchestration and both identity modules so outputs equal deployed trust.
func characters(value string, allowed string) bool =>
  !empty(value) && !contains(map(range(0, length(value)), i => contains(allowed, substring(value, i, 1))), false)
func positiveId(value string) bool => characters(value, '0123456789') && !startsWith(value, '0')
func namePart(value string, expected string) bool =>
  value == expected || (length(split(value, '@')) == 2 && first(split(value, '@')) == expected && positiveId(last(split(
    value,
    '@'
  ))))
func repositoryMatches(value string, repo string) bool =>
  length(split(value, '/')) == 2
    ? (namePart(first(split(value, '/')), first(split(repo, '/'))) && namePart(
        last(split(value, '/')),
        last(split(repo, '/'))
      ) && contains(first(split(value, '/')), '@') == contains(last(split(value, '/')), '@'))
    : false
func claimValid(claim object, repo string, context string) bool =>
  claim.key == 'repo'
    ? repositoryMatches(claim.value, repo)
    : (contains(['repository_owner_id', 'repository_id'], claim.key)
        ? positiveId(claim.value)
        : '${claim.key}:${claim.value}' == context)
func idsAgree(claims array, repository string) bool =>
  !contains(repository, '@') || !contains(
    map(
      filter(claims, claim => contains(['repository_owner_id', 'repository_id'], claim.key)),
      claim =>
        claim.value == last(split(
          claim.key == 'repository_owner_id' ? first(split(repository, '/')) : last(split(repository, '/')),
          '@'
        ))
    ),
    false
  )
func claimsValid(claims array, repo string, context string) bool => (length(union(map(claims, claim => claim.key), [])) == length(claims) && length(filter(claims, claim => claim.key == 'repo')) == 1 && length(filter(claims, claim => contains(['environment', 'ref'], claim.key))) == 1 && !contains(map(claims, claim => claimValid(claim, repo, context)), false) && idsAgree(claims, first(concat(filter(claims, claim => claim.key == 'repo'), [{ value: '' }])).value))
func subjectValid(parts array, repo string, context string) bool =>
  contains([4, 8], length(parts))
    ? claimsValid(map(range(0, length(parts) / 2), i => { key: parts[i * 2], value: parts[i * 2 + 1] }), repo, context)
    : false

@export()
func isSubjectValid(subject string, repo string, context string) bool =>
  (length(split(repo, '/')) == 2 && characters(
    first(split(repo, '/')),
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'
  ) && characters(last(split(repo, '/')), 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-') && subjectValid(
    split(subject, ':'),
    repo,
    context
  ))

@export()
func checkedSubject(subject string, repo string, context string) string =>
  isSubjectValid(subject, repo, context)
    ? subject
    : fail('OIDC subject must bind exactly to the target repo and backend context, with optional consistent paired positive IDs and no wildcards or duplicate claims.')

@export()
type SubjectOverrides = {
  *: {
    jobs: string?
    sandbox: string?
  }
}

@export()
type RepositorySubjects = {
  *: string
}
