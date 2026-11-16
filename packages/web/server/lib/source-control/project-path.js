
export const joinProjectPath = (owner, name) => (owner ? `${owner}/${name}` : name);

export const splitProjectPath = (path) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { owner: '', name: path } : { owner: path.slice(0, slash), name: path.slice(slash + 1) };
};

export const allowsTopLevelProjects = (descriptor) => descriptor?.repositoryPath === 'path';
