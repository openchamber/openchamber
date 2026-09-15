/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code's SVG SCM history renderer:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts

import React from 'react';
import {
  getHistoryItemColumn,
  getHistoryItemMaxColumns,
  getHistoryItemSecondaryParentColumns,
  type GitHistoryItemViewModel,
} from './gitGraph';

const SWIMLANE_HEIGHT = 22;
const SWIMLANE_WIDTH = 11;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

interface GitGraphSegmentProps {
  viewModel: GitHistoryItemViewModel;
  totalColumns?: number;
}

function verticalPath(x: number, y1: number, y2: number): string {
  return `M ${x} ${y1} V ${y2}`;
}

function GraphPath({ d, color, strokeWidth = 0.75 }: { d: string; color: string; strokeWidth?: number }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeLinecap="round"
      strokeWidth={strokeWidth}
      aria-hidden="true"
      role="presentation"
    />
  );
}

export const GitGraphSegment: React.FC<GitGraphSegmentProps> = ({ viewModel, totalColumns }) => {
  const historyItem = viewModel.historyItem;
  const inputSwimlanes = viewModel.inputSwimlanes;
  const outputSwimlanes = viewModel.outputSwimlanes;
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);
  const circleIndex = getHistoryItemColumn(viewModel);
  const columnCount = Math.max(totalColumns ?? 0, getHistoryItemMaxColumns(viewModel));
  const circleColor = outputSwimlanes[circleIndex]?.color
    ?? inputSwimlanes[circleIndex]?.color
    ?? viewModel.nodeColor;
  const secondaryParentColumns = getHistoryItemSecondaryParentColumns(viewModel);

  const paths: React.ReactNode[] = [];
  let outputSwimlaneIndex = 0;

  for (let index = 0; index < inputSwimlanes.length; index++) {
    const color = inputSwimlanes[index].color;

    if (inputSwimlanes[index].id === historyItem.id) {
      if (index !== circleIndex) {
        const d = [
          `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
          `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`,
          `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
        ].join(' ');
        paths.push(<GraphPath key={`input-${index}`} d={d} color={color} />);
      } else {
        outputSwimlaneIndex++;
      }
      continue;
    }

    if (
      outputSwimlaneIndex < outputSwimlanes.length
      && inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id
    ) {
      if (index === outputSwimlaneIndex) {
        paths.push(
          <GraphPath
            key={`straight-${index}`}
            d={verticalPath(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT)}
            color={color}
          />,
        );
      } else {
        const d = [
          `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
          'V 6',
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${(SWIMLANE_WIDTH * (index + 1)) - SWIMLANE_CURVE_RADIUS} ${SWIMLANE_HEIGHT / 2}`,
          `H ${(SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)) + SWIMLANE_CURVE_RADIUS}`,
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${(SWIMLANE_HEIGHT / 2) + SWIMLANE_CURVE_RADIUS}`,
          `V ${SWIMLANE_HEIGHT}`,
        ].join(' ');
        paths.push(<GraphPath key={`curve-${index}-${outputSwimlaneIndex}`} d={d} color={color} />);
      }

      outputSwimlaneIndex++;
    }
  }

  for (const parentColumn of secondaryParentColumns) {
    const d = [
      `M ${SWIMLANE_WIDTH * parentColumn} ${SWIMLANE_HEIGHT / 2}`,
      `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentColumn + 1)} ${SWIMLANE_HEIGHT}`,
      `M ${SWIMLANE_WIDTH * parentColumn} ${SWIMLANE_HEIGHT / 2}`,
      `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
    ].join(' ');
    paths.push(
      <GraphPath
        key={`parent-${parentColumn}`}
        d={d}
        color={outputSwimlanes[parentColumn]?.color ?? circleColor}
      />,
    );
  }

  if (inputIndex !== -1) {
    paths.push(
      <GraphPath
        key="to-circle"
        d={verticalPath(SWIMLANE_WIDTH * (circleIndex + 1), 0, SWIMLANE_HEIGHT / 2)}
        color={inputSwimlanes[inputIndex].color}
      />,
    );
  }

  if (historyItem.parentIds.length > 0) {
    paths.push(
      <GraphPath
        key="from-circle"
        d={verticalPath(SWIMLANE_WIDTH * (circleIndex + 1), SWIMLANE_HEIGHT / 2, SWIMLANE_HEIGHT)}
        color={circleColor}
      />,
    );
  }

  const circleX = SWIMLANE_WIDTH * (circleIndex + 1);
  const circleY = SWIMLANE_WIDTH;
  const width = SWIMLANE_WIDTH * (columnCount + 1);

  return (
    <svg
      width={width}
      height={SWIMLANE_HEIGHT}
      viewBox={`0 0 ${width} ${SWIMLANE_HEIGHT}`}
      className="block shrink-0 overflow-visible"
      aria-hidden="true"
      role="presentation"
    >
      {paths}
      {viewModel.kind === 'HEAD' ? (
        <>
          <circle cx={circleX} cy={circleY} r={CIRCLE_RADIUS + 3} fill={circleColor} strokeWidth={CIRCLE_STROKE_WIDTH} />
          <circle cx={circleX} cy={circleY} r={CIRCLE_STROKE_WIDTH} fill="var(--background)" stroke={circleColor} strokeWidth={CIRCLE_RADIUS} />
        </>
      ) : viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes' ? (
        <>
          <circle cx={circleX} cy={circleY} r={CIRCLE_RADIUS + 3} fill={circleColor} strokeWidth={CIRCLE_STROKE_WIDTH} />
          <circle cx={circleX} cy={circleY} r={CIRCLE_RADIUS + 1} fill="var(--background)" stroke={circleColor} strokeWidth={CIRCLE_STROKE_WIDTH + 1} />
          <circle
            cx={circleX}
            cy={circleY}
            r={CIRCLE_RADIUS + 1}
            fill="none"
            stroke={circleColor}
            strokeDasharray="4,2"
            strokeWidth={CIRCLE_STROKE_WIDTH - 1}
          />
        </>
      ) : historyItem.parentIds.length > 1 ? (
        <>
          <circle cx={circleX} cy={circleY} r={CIRCLE_RADIUS + 2} fill={circleColor} stroke={circleColor} strokeWidth={CIRCLE_STROKE_WIDTH} />
          <circle cx={circleX} cy={circleY} r={CIRCLE_RADIUS - 1} fill="var(--background)" stroke={circleColor} strokeWidth={CIRCLE_STROKE_WIDTH} />
        </>
      ) : (
        <circle cx={circleX} cy={circleY} r={CIRCLE_RADIUS + 1} fill={circleColor} stroke="var(--background)" strokeWidth={CIRCLE_STROKE_WIDTH} />
      )}
    </svg>
  );
};
