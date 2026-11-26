export const DETAIL_COMMENT_LIMIT = 50;
const DETAIL_COMMIT_LIMIT = 50;
const DETAIL_THREAD_LIMIT = 50;
export const DETAIL_THREAD_COMMENT_LIMIT = 50;

export const DETAIL_QUERY = `
query ReferenceDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
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
      }
    }
  }
}
fragment DetailComment on IssueComment { databaseId author { login avatarUrl } body createdAt url viewerCanUpdate viewerCanDelete }
`;

export const DETAIL_THREADS_QUERY = `
query ReferenceThreads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: ${DETAIL_THREAD_LIMIT}) {
        nodes {
          id
          isOutdated
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
`;
