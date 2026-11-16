export const DOCUMENT_DATA_URL = /^data:[^,]*;base64,/;

/** Whether a diff holds the two files themselves; older servers send nothing here. */
export const isDocumentVersions = (original: string, modified: string): boolean => (
  DOCUMENT_DATA_URL.test(original) || DOCUMENT_DATA_URL.test(modified)
);
