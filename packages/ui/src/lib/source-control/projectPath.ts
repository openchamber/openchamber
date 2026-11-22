
export const joinProjectPath = (owner: string, name: string): string => (owner ? `${owner}/${name}` : name);

export const splitProjectPath = (path: string): { owner: string; repo: string } => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { owner: '', repo: path } : { owner: path.slice(0, slash), repo: path.slice(slash + 1) };
};
