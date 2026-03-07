// screen.ts — Terminal layout calculator

export interface ScreenLayout {
  statusRow: number;
  fpTop: number;
  fpBottom: number;
  fpRows: number;
  fpCols: number;
  // Minimap overlay in upper-right of FP view
  minimapTop: number;
  minimapLeft: number;
  minimapRows: number;
  minimapCols: number;
  separatorRow: number;
  chatTop: number;
  chatBottom: number;
  chatLines: number;
  inputRow: number;
  totalCols: number;
  totalRows: number;
  // Kept for backward compat in tests — now aliases for minimap
  gridTop: number;
  gridBottom: number;
  gridRows: number;
  gridCols: number;
}

export function computeLayout(cols: number, rows: number): ScreenLayout {
  const statusRow = 0;
  const inputRow = rows - 1;
  const chatLines = 5;
  const separatorRow = rows - 7;
  const chatTop = separatorRow + 1;
  const chatBottom = rows - 2;

  // FP view takes all space between status bar and separator
  const fpTop = 1;
  const fpBottom = Math.max(1, separatorRow - 1);
  const fpRows = Math.max(1, fpBottom - fpTop + 1);
  const fpCols = cols;

  // Minimap: upper-right corner, ~25% width, ~40% height of FP area
  const minimapCols = Math.max(8, Math.floor(cols * 0.25));
  const minimapRows = Math.max(4, Math.floor(fpRows * 0.4));
  const minimapLeft = cols - minimapCols;
  const minimapTop = fpTop;

  return {
    statusRow,
    fpTop,
    fpBottom,
    fpRows,
    fpCols,
    minimapTop,
    minimapLeft,
    minimapRows,
    minimapCols,
    separatorRow,
    chatTop,
    chatBottom,
    chatLines,
    inputRow,
    totalCols: cols,
    totalRows: rows,
    // Backward compat — grid is now the minimap
    gridTop: minimapTop,
    gridBottom: minimapTop + minimapRows - 1,
    gridRows: minimapRows,
    gridCols: minimapCols,
  };
}
