/**
 * Times of bars after the last bar (moved to oakscriptjs).
 *
 * Pine draws on future bars: `line.new(..., bar_index + 15, ...)`, box edges after the last bar, `plot(..., offset = k)`.
 * A port gives these points the time of the future bar: the last bar time plus k times the bar interval, the most
 * frequent gap between two consecutive bars. The example renderer adds the same future bar slots to the chart.
 */
export { barInterval, barTime } from 'oakscriptjs';
