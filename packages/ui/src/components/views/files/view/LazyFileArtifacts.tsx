import React from 'react';

export const TableArtifact = React.lazy(() => import('../previews/TableArtifact').then((module) => ({ default: module.TableArtifact })));
export const DataFileArtifact = React.lazy(() => import('../previews/DataFileArtifact').then((module) => ({ default: module.DataFileArtifact })));
export const OfficeArtifact = React.lazy(() => import('../previews/OfficeArtifact').then((module) => ({ default: module.OfficeArtifact })));
