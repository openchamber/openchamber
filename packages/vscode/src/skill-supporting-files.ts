import fs from 'node:fs';
import path from 'node:path';

const resolveSkillSupportingFilePath = (skillDir: string, relativePath: string): string => {
  const root = fs.realpathSync(skillDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  const isWithin = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isWithin) {
    const error: NodeJS.ErrnoException = new Error('Access to file denied');
    error.code = 'EACCES';
    throw error;
  }
  return target;
};

export const readSkillSupportingFile = (skillDir: string, relativePath: string): string | null => {
  const fullPath = resolveSkillSupportingFilePath(skillDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
};

export const writeSkillSupportingFile = (skillDir: string, relativePath: string, content: string): void => {
  const fullPath = resolveSkillSupportingFilePath(skillDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
};

export const deleteSkillSupportingFile = (skillDir: string, relativePath: string): void => {
  const root = fs.realpathSync(skillDir);
  const fullPath = resolveSkillSupportingFilePath(skillDir, relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    let parentDir = path.dirname(fullPath);
    while (parentDir !== root) {
      try {
        const entries = fs.readdirSync(parentDir);
        if (entries.length === 0) {
          fs.rmdirSync(parentDir);
          parentDir = path.dirname(parentDir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
};