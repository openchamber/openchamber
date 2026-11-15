// The newest comments and reviews; `totalCount` says how many there are.
export const DETAIL_COMMENT_LIMIT = 50;
// The newest commits, so the preview can show what each review answered.
const DETAIL_COMMIT_LIMIT = 50;
// The newest review threads, and the comments that open and answer each.
const DETAIL_THREAD_LIMIT = 50;
export const DETAIL_THREAD_COMMENT_LIMIT = 50;

export const DETAIL_QUERY = `
query ReferenceDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    # What this account may do in the repository: base and branch writes need WRITE.
    viewerPermission
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number
        body
        viewerCanUpdate
        assignees(first: 30) { nodes { login avatarUrl } }
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
      }
      ... on PullRequest {
        number
        body
        viewerCanUpdate
        state
        reviewDecision
        # The preview's checks, from the PR itself rather than the list's batch.
        headCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { databaseId name status conclusion startedAt checkSuite { app { databaseId } } }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
        reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } } } }
        additions
        deletions
        changedFiles
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
        commits(last: ${DETAIL_COMMIT_LIMIT}) {
          totalCount
          nodes { commit { oid messageHeadline committedDate url author { name user { login avatarUrl } } } }
        }
        reviews(last: 30) {
          nodes { author { login avatarUrl } body state createdAt url }
        }
        # Comments on lines come as the threads they open, replies included.
        reviewThreads(last: ${DETAIL_THREAD_LIMIT}) {
          nodes {
            id
            isResolved
            viewerCanResolve
            viewerCanUnresolve
            viewerCanReply
            comments(first: ${DETAIL_THREAD_COMMENT_LIMIT}) {
              nodes { author { login avatarUrl } body createdAt url path line originalLine startLine originalStartLine diffHunk }
            }
          }
        }
      }
    }
  }
}
fragment DetailComment on IssueComment { databaseId author { login avatarUrl } body createdAt url viewerCanUpdate viewerCanDelete }
`;
