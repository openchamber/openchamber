import React from 'react';

// Table, data and office previews load when a file needs one. A module that
// cannot be fetched, such as a chunk an antivirus quarantined, then fails only
// that preview, and the rest of Files keeps working.
export const TableArtifact = React.lazy(() => import('../previews/TableArtifact').then((module) => ({ default: module.TableArtifact })));
export const DataFileArtifact = React.lazy(() => import('../previews/DataFileArtifact').then((module) => ({ default: module.DataFileArtifact })));
export const OfficeArtifact = React.lazy(() => import('../previews/OfficeArtifact').then((module) => ({ default: module.OfficeArtifact })));
