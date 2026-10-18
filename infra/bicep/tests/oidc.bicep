import { isSubjectValid } from '../oidc.bicep'

var cases = loadJsonContent('../../../contracts/backend/v1/fixtures/oidc-subjects.json')
var results = map(cases, example => {
  name: '${example.backend}_${example.name}'
  passed: isSubjectValid(example.subject, 'example/repository', example.backend == 'jobs' ? 'ref:refs/heads/main' : 'environment:squad-sandbox-issue') == example.valid
})

output failedCases array = filter(results, result => !result.passed)
