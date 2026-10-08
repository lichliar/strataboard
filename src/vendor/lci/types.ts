/**
 * Output types of the indicators: the oakscriptjs IndicatorResult shapes, shared by the built-in indicators and
 * scripts run with executeScript.
 *
 * A point on a bar after the last bar (Pine bar_index + k) has the time of that future bar: barTime(bars, index).
 * A property that is not set is omitted (the renderer applies the Pine default); a colour set to na is 'transparent'.
 */
export type {
  PineSize,
  MarkerData,
  MarkerPosition,
  MarkerShape,
  BarColorData,
  BgColorData,
  PlotCandleData,
  PlotBarData,
  LabelData,
  LabelStyle,
  LineDrawingData,
  BoxData,
  LinefillData,
  PolylineData,
  TableData,
  TableCellData,
  TableCellData as TableCell,
  TableMergeData,
  TablePosition,
} from 'oakscriptjs';
