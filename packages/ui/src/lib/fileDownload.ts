export const triggerFileDownload = (filePath: string, fileName: string): void => {
  const downloadUrl = `/api/fs/raw?path=${encodeURIComponent(filePath)}`;

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
