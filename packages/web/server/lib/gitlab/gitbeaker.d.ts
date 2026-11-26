declare module '@gitbeaker/rest' {
  type ProjectId = string | number;
  type Options = import('./client.js').GitLabRequesterOptions['searchParams'];
  type ResponseBody = Awaited<ReturnType<import('./client.js').GitLabRequester['get']>>['body'];
  type ExpandedPage = import('../shared/json-values.js').JsonObject & {
    data: import('../shared/json-values.js').JsonValue[];
    paginationInfo: { [key: string]: string | number | null | undefined };
  };
  type Reply = Promise<ResponseBody | ExpandedPage>;

  interface Notes {
    all(projectId: ProjectId, number: import('../shared/json-values.js').JsonValue | undefined, options?: Options): Reply;
    show(projectId: ProjectId, number: number, noteId: number): Reply;
    create(projectId: ProjectId, number: number, body: string): Reply;
    edit(projectId: ProjectId, number: number, noteId: number, options: Options): Reply;
    remove(projectId: ProjectId, number: number, noteId: number): Reply;
  }

  export class Gitlab {
    constructor(options: {
      host: string;
      token?: string | undefined;
      oauthToken?: string | undefined;
      requesterFn: (service: import('./client.js').GitLabRequesterService) => import('./client.js').GitLabRequester;
    });

    readonly Projects: { show(projectId: unknown): Reply };
    readonly Users: { showCurrentUser(): Reply };
    readonly Jobs: { all(projectId: ProjectId, options?: Options): Reply };
    readonly ProjectLabels: { all(projectId: ProjectId, options?: Options): Reply };
    readonly ProjectMembers: { all(projectId: ProjectId, options?: Options): Reply };
    readonly Branches: { all(projectId: ProjectId, options?: Options): Reply };
    readonly RepositoryFiles: { showRaw(projectId: ProjectId, path: string, ref: NonNullable<Options>['ref']): Reply };
    readonly Issues: {
      all(options?: Options): Reply;
      show(number: number, options?: Options): Reply;
      edit(projectId: ProjectId, number: number, options: Options): Reply;
    };
    readonly IssueNotes: Notes;
    readonly MergeRequestNotes: Notes;
    readonly MergeRequests: {
      requester: import('./client.js').GitLabRequester;
      all(options?: Options): Reply;
      show(projectId: ProjectId, number: number): Reply;
      allCommits(projectId: ProjectId, number: number, options?: Options): Reply;
      allDiffs(projectId: ProjectId, number: number, options?: Options): Reply;
      showReviewers(projectId: ProjectId, number: number): Reply;
      create(projectId: ProjectId, head: string, base: string, title: string, options?: Options): Reply;
      edit(projectId: ProjectId, number: number, options: Options): Reply;
      merge(projectId: ProjectId, number: number, options?: Options): Reply;
      rebase(projectId: ProjectId, number: number): Reply;
    };
    readonly MergeRequestApprovals: {
      approve(projectId: ProjectId, number: number, options?: Options): Reply;
      unapprove(projectId: ProjectId, number: number): Reply;
      showConfiguration(projectId: ProjectId, options: { mergerequestIId: number }): Reply;
    };
    readonly MergeRequestDiscussions: {
      all(projectId: ProjectId, number: number, options?: Options): Reply;
      show(projectId: ProjectId, number: number, threadId: string): Reply;
      addNote(projectId: ProjectId, number: number, threadId: string, body: string): Reply;
      resolve(projectId: ProjectId, number: number, threadId: string, resolved: boolean): Reply;
      create(projectId: ProjectId, number: number, body: string): Reply;
    };
    readonly MergeRequestDraftNotes: {
      all(projectId: ProjectId, number: number): Reply;
      create(projectId: ProjectId, number: number, body: string, options?: Options): Reply;
      edit(projectId: ProjectId, number: number, draftId: number, options: Options): Reply;
      remove(projectId: ProjectId, number: number, draftId: number): Reply;
      publishBulk(projectId: ProjectId, number: number): Reply;
    };
  }
}
