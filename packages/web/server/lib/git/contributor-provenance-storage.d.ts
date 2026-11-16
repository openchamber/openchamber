export function isContributorForkGitDirectory(input: {
  filePath: string;
  gitDirectory: string;
}): Promise<boolean>;
