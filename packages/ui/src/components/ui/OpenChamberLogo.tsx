import React, { useMemo } from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';

const LEFT_FACE_CELL_OPACITIES = [
  0.2, 0.45, 0.15, 0.55,
  0.35, 0.1, 0.5, 0.25,
  0.4, 0.3, 0.45, 0.15,
  0.55, 0.2, 0.35, 0.1,
];

const RIGHT_FACE_CELL_OPACITIES = [
  0.3, 0.15, 0.45, 0.25,
  0.5, 0.35, 0.1, 0.4,
  0.2, 0.55, 0.3, 0.15,
  0.45, 0.25, 0.4, 0.2,
];

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

// Generate grid cells for a face (4x4 grid)
// Returns array of parallelogram paths in isometric projection
const generateFaceGrid = (
  topLeft: { x: number; y: number },
  topRight: { x: number; y: number },
  bottomRight: { x: number; y: number },
  bottomLeft: { x: number; y: number },
  gridSize: number = 4
) => {
  const cells: Array<{ path: string; row: number; col: number }> = [];
  
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      // Interpolate corners for this cell
      const t1 = col / gridSize;
      const t2 = (col + 1) / gridSize;
      const s1 = row / gridSize;
      const s2 = (row + 1) / gridSize;
      
      // Bilinear interpolation for each corner of the cell
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      const bilinear = (tl: number, tr: number, br: number, bl: number, t: number, s: number) => {
        const top = lerp(tl, tr, t);
        const bottom = lerp(bl, br, t);
        return lerp(top, bottom, s);
      };
      
      const p1 = {
        x: bilinear(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x, t1, s1),
        y: bilinear(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y, t1, s1),
      };
      const p2 = {
        x: bilinear(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x, t2, s1),
        y: bilinear(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y, t2, s1),
      };
      const p3 = {
        x: bilinear(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x, t2, s2),
        y: bilinear(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y, t2, s2),
      };
      const p4 = {
        x: bilinear(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x, t1, s2),
        y: bilinear(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y, t1, s2),
      };
      
      cells.push({
        path: `M${p1.x} ${p1.y} L${p2.x} ${p2.y} L${p3.x} ${p3.y} L${p4.x} ${p4.y} Z`,
        row,
        col,
      });
    }
  }
  
  return cells;
};

export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const themeContext = useOptionalThemeSystem();

  let isDark = true;
  if (themeContext) {
    isDark = themeContext.currentTheme.metadata.variant !== 'light';
  } else if (typeof window !== 'undefined') {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const strokeColor = useMemo(() => {
    if (themeContext) {
      return themeContext.currentTheme.colors.surface.foreground;
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-stroke').trim();
      if (fromVars) {
        return fromVars;
      }
    }
    return isDark ? 'white' : 'black';
  }, [themeContext, isDark]);

  const supportsColorMix = useMemo(() => {
    if (typeof window === 'undefined' || typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
      return false;
    }
    return CSS.supports('color', 'color-mix(in srgb, white 50%, transparent)');
  }, []);

  const fillColor = useMemo(() => {
    if (themeContext) {
      if (supportsColorMix) {
        return `color-mix(in srgb, ${strokeColor} 15%, transparent)`;
      }
      return isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-face-fill').trim();
      if (fromVars) {
        return fromVars;
      }
    }
    return isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
  }, [themeContext, supportsColorMix, strokeColor, isDark]);

  const cellHighlightColor = useMemo(() => {
    if (themeContext) {
      if (supportsColorMix) {
        return `color-mix(in srgb, ${strokeColor} 35%, transparent)`;
      }
      return isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)';
    }
    if (typeof window !== 'undefined') {
      const fromVars = getComputedStyle(document.documentElement).getPropertyValue('--splash-cell-fill').trim();
      if (fromVars) {
        return fromVars;
      }
    }
    return isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)';
  }, [themeContext, supportsColorMix, strokeColor, isDark]);

  const logoFillColor = strokeColor;



  // Isometric cube geometry (mathematically correct)
  // For true isometric: horizontal edges at ±30° from horizontal
  // cos(30°) ≈ 0.866, sin(30°) = 0.5
  // Cube edge length = 46, center at (50, 52) - larger cube, slightly lower
  const edge = 48;
  const cos30 = 0.866;
  const sin30 = 0.5;
  const centerY = 50;
  
  // Key points of the isometric cube
  const top = { x: 50, y: centerY - edge };                           // top vertex
  const left = { x: 50 - edge * cos30, y: centerY - edge * sin30 };   // top-left
  const right = { x: 50 + edge * cos30, y: centerY - edge * sin30 };  // top-right  
  const center = { x: 50, y: centerY };                                // center (front vertex of top face)
  const bottomLeft = { x: 50 - edge * cos30, y: centerY + edge * sin30 };  // bottom-left
  const bottomRight = { x: 50 + edge * cos30, y: centerY + edge * sin30 }; // bottom-right
  const bottom = { x: 50, y: centerY + edge };                         // bottom vertex

  // Isometric transformation matrix for top face
  // Maps a flat square to the isometric rhombus (top face)
  // Center of top face rhombus: average of top, left, center, right vertices
  // topFaceCenter.x = (top.x + left.x + center.x + right.x) / 4 = 50
  // topFaceCenter.y = (top.y + left.y + center.y + right.y) / 4
  const topFaceCenterY = (top.y + left.y + center.y + right.y) / 4;
  const isoMatrix = `matrix(0.866, 0.5, -0.866, 0.5, 50, ${topFaceCenterY})`;

  // Generate grid cells for both faces
  // Left face: center -> left -> bottomLeft -> bottom
  const leftFaceCells = generateFaceGrid(left, center, bottom, bottomLeft);
  
  // Right face: center -> right -> bottomRight -> bottom  
  const rightFaceCells = generateFaceGrid(center, right, bottomRight, bottom);

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="OpenChamber logo"
    >
      <style>{`
        @keyframes openchamber-logo-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .openchamber-logo-pulse {
          animation: openchamber-logo-pulse 3s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .openchamber-logo-pulse {
            animation: none;
          }
        }
      `}</style>

      {/* Left face - base fill */}
      <path
        d={`M${center.x} ${center.y} L${left.x} ${left.y} L${bottomLeft.x} ${bottomLeft.y} L${bottom.x} ${bottom.y} Z`}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      
      {/* Left face - grid cells with varying opacity */}
      {leftFaceCells.map((cell, i) => (
        <path
          key={`left-${i}`}
          d={cell.path}
          fill={cellHighlightColor}
          opacity={LEFT_FACE_CELL_OPACITIES[cell.row * 4 + (3 - cell.col)] ?? 0.35}
        />
      ))}
      
      {/* Right face - base fill */}
      <path
        d={`M${center.x} ${center.y} L${right.x} ${right.y} L${bottomRight.x} ${bottomRight.y} L${bottom.x} ${bottom.y} Z`}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      
      {/* Right face - grid cells with varying opacity */}
      {rightFaceCells.map((cell, i) => (
        <path
          key={`right-${i}`}
          d={cell.path}
          fill={cellHighlightColor}
          opacity={RIGHT_FACE_CELL_OPACITIES[cell.row * 4 + cell.col] ?? 0.35}
        />
      ))}
      
      {/* Top face - open (no fill), only stroke */}
      <path
        d={`M${top.x} ${top.y} L${left.x} ${left.y} L${center.x} ${center.y} L${right.x} ${right.y} Z`}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      
      {/* OpenCode logo on top face */}
      <g className={isAnimated ? 'openchamber-logo-pulse' : undefined} opacity={1}>
        {/* 
          Isometric transform for top face:
          OpenCode logo (32x40 viewBox) centered and projected to isometric plane
        */}
        <g transform={`${isoMatrix} scale(0.75)`}>
          {/* OpenCode logo - outer frame with inner square */}
          {/* Outer frame (centered at origin, original: 0,0 to 32,40) */}
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M-16 -20 L16 -20 L16 20 L-16 20 Z M-8 -12 L-8 12 L8 12 L8 -12 Z"
            fill={logoFillColor}
          />
          {/* Inner square */}
          <path
            d="M-8 -4 L8 -4 L8 12 L-8 12 Z"
            fill={logoFillColor}
            fillOpacity="0.4"
          />
        </g>
      </g>
    </svg>
  );
};
