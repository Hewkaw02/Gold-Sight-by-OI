import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import type { DominanceOutlook, OptionsPrediction, PriceBar, PriceChartMode, PriceTimeframe, RollMarker, WallMode, WallSegment } from '../domain/types';
import { buildPriceProjection } from '../domain/price-projection';
import { chartPriceLabel, chartPriceValue, toChartPriceBars } from '../domain/price-chart';
import { wallExpiryEndTime, wallExpiryState } from '../domain/wall-status';

interface OIWallChartProps {
  price: PriceBar[];
  walls: WallSegment[];
  rolls: RollMarker[];
  timeframe: PriceTimeframe;
  priceMode: PriceChartMode;
  wallMode: WallMode;
  displayTimezone: string;
  showProjection: boolean;
  projectionHorizonDays: number;
  showForecastRange: boolean;
  dominanceOutlook: DominanceOutlook | null;
  optionsPrediction: OptionsPrediction | null;
  showDominanceProjection: boolean;
}

const GREEN = '#5eead4';
const RED = '#fb7185';
const PROJECTION = '#fb923c';
const DOMINANCE_PROJECTION = '#c084fc';
const EXPIRED_WALL = '#64748b';
const MIXED_WALL = '#f59e0b';
const BALANCED_WALL = '#f8fafc';
const HIGH_OI_THRESHOLD = 10_000;
const BALANCED_DOMINANCE_LIMIT = 0.15;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatTime(value: string, timezone: string, includeTime = true) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(value));
}

function wallWidth(totalOi: number, maxOi: number, emphasize: boolean) {
  if (maxOi <= 0) return 1;
  const base = 1.2 + Math.min(5, (totalOi / maxOi) * 5);
  return emphasize ? Math.min(8, Math.max(base + 1.75, 4.5)) : base;
}

function oiForWall(wall: WallSegment, wallMode: WallMode) {
  if (wallMode === 'call') return wall.callOi;
  if (wallMode === 'put') return wall.putOi;
  return wall.totalOi;
}

function wallChartEnd(wall: WallSegment) {
  const observedEnd = Date.parse(wall.to);
  const expiryEnd = wallExpiryEndTime(wall);
  if (wall.status !== 'active') return Number.isFinite(observedEnd) ? observedEnd : 0;
  return Math.max(Number.isFinite(observedEnd) ? observedEnd : 0, expiryEnd ?? 0);
}

function wallColor(wall: WallSegment, expiryState: ReturnType<typeof wallExpiryState>, side: 'call' | 'put' | 'combined') {
  if (expiryState === 'expired') return EXPIRED_WALL;
  if (expiryState === 'mixed') return MIXED_WALL;
  if (Math.abs(wall.dominance) <= BALANCED_DOMINANCE_LIMIT) return BALANCED_WALL;
  if (side === 'call') return GREEN;
  if (side === 'put') return RED;
  return wall.dominance > 0 ? GREEN : RED;
}

function startOfLatestDataWindow(price: PriceBar[]) {
  const latestTime = price.reduce((latest, bar) => {
    const time = Date.parse(bar.time);
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(latestTime)) return null;
  const latestDate = new Date(latestTime);
  return Date.UTC(latestDate.getUTCFullYear(), 5, 1);
}

export default function OIWallChart({
  price,
  walls,
  rolls,
  timeframe,
  priceMode,
  wallMode,
  displayTimezone,
  showProjection,
  projectionHorizonDays,
  showForecastRange,
  dominanceOutlook,
  optionsPrediction,
  showDominanceProjection,
}: OIWallChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const visiblePrice = useMemo(() => {
    const latestOpenTime = price.filter((bar) => !bar.isClosed).reduce((latest, bar) => {
      const time = Date.parse(bar.time);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, Number.NEGATIVE_INFINITY);
    const renderablePrice = price
      // Keep historical data closed, but retain the single newest open bar so
      // the chart presents the freshest source value without treating it as
      // completed history.
      .filter((bar) => bar.isClosed || (Number.isFinite(latestOpenTime) && Date.parse(bar.time) === latestOpenTime))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const windowStart = startOfLatestDataWindow(renderablePrice);
    return windowStart === null
      ? renderablePrice
      : renderablePrice.filter((bar) => Date.parse(bar.time) >= windowStart);
  }, [price]);
  const visibleWalls = useMemo(() => walls.filter((wall) => {
    if (wallMode === 'call') return wall.callOi > 0;
    if (wallMode === 'put') return wall.putOi > 0;
    return wall.totalOi > 0;
  }), [walls, wallMode]);
  const projectionPrice = useMemo(() => toChartPriceBars(price, priceMode), [price, priceMode]);
  const projection = useMemo(
    () => showProjection ? buildPriceProjection(projectionPrice, timeframe, projectionHorizonDays, optionsPrediction) : null,
    [optionsPrediction, projectionPrice, projectionHorizonDays, showProjection, timeframe],
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    const priceTimes = visiblePrice.map((bar) => new Date(bar.time).getTime());
    const lastActualTime = priceTimes.at(-1) ?? 0;
    const wallReferenceTime = Math.max(lastActualTime, Date.now());
    const maxWallOi = Math.max(...visibleWalls.map((wall) => {
      if (wallMode === 'call') return wall.callOi;
      if (wallMode === 'put') return wall.putOi;
      return wall.totalOi;
    }), 1);
    const chartHorizonEnd = lastActualTime + projectionHorizonDays * DAY_MS;
    const maxWallEnd = Math.min(Math.max(...visibleWalls.map(wallChartEnd), 0), chartHorizonEnd);

    type WallLineSeries = {
      name: string;
      type: 'line';
      yAxisIndex: number;
      data: number[][];
      showSymbol: boolean;
      silent: boolean;
      lineStyle: { color: string; width: number; opacity: number; type: 'solid' | 'dashed' | 'dotted' };
      z: number;
    };
    const wallSeries: WallLineSeries[] = visibleWalls.flatMap((wall) => {
      const expiryState = wallExpiryState(wall, wallReferenceTime);
      const wallEnd = wallChartEnd(wall);
      const buildSeries = (side: 'call' | 'put' | 'combined'): WallLineSeries | null => {
        const sideOi = side === 'call' ? wall.callOi : side === 'put' ? wall.putOi : wall.totalOi;
        if (sideOi <= 0) return null;
        const highOi = (wallMode === 'split' ? wall.totalOi : sideOi) >= HIGH_OI_THRESHOLD;
        const dominanceColor = wallColor(wall, expiryState, side);
        const data = [[new Date(wall.from).getTime(), wall.strike], [wallEnd, wall.strike]];
        return {
          name: `${side.toUpperCase()} wall ${wall.strike}`,
          type: 'line' as const,
          yAxisIndex: 0,
          data,
          showSymbol: false,
          silent: true,
          lineStyle: {
            color: dominanceColor,
            width: wallWidth(sideOi, maxWallOi, highOi),
            opacity: expiryState === 'expired' ? 0.45 : expiryState === 'mixed' ? 0.58 : wall.stale ? 0.35 : side === 'combined' ? 0.78 : 0.62,
            type: expiryState === 'expired'
              ? 'dashed' as const
              : expiryState === 'mixed'
                ? 'dotted' as const
                : side === 'put' && wallMode === 'split'
                  ? 'dashed' as const
                  : 'solid' as const,
          },
          z: 4,
        };
      };

      if (wallMode === 'split') return [buildSeries('call'), buildSeries('put')].filter((series): series is WallLineSeries => series !== null);
      if (wallMode === 'call') return [buildSeries('call')].filter((series): series is WallLineSeries => series !== null);
      if (wallMode === 'put') return [buildSeries('put')].filter((series): series is WallLineSeries => series !== null);
      return [buildSeries('combined')].filter((series): series is WallLineSeries => series !== null);
    });
    const projectionSeries = projection ? {
      name: `Projected price · ${projection.horizonLabel}`,
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.data,
      showSymbol: false,
      smooth: 0.45,
      smoothMonotone: 'x' as const,
      lineStyle: { color: PROJECTION, width: 2, type: 'dashed' as const },
      itemStyle: { color: PROJECTION },
      z: 5,
    } : null;
    const optionsScenarioSeries = projection?.optionsData ? {
      name: 'Options-aware scenario guide',
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.optionsData,
      showSymbol: false,
      smooth: 0.45,
      smoothMonotone: 'x' as const,
      lineStyle: { color: '#38bdf8', width: 2, type: 'dashed' as const },
      itemStyle: { color: '#38bdf8' },
      z: 5,
    } : null;
    const forecastBandBaseline = projection && showForecastRange ? {
      name: 'Forecast error band baseline',
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.lowerBand,
      stack: 'forecast-range',
      showSymbol: false,
      silent: true,
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0 },
      tooltip: { show: false },
      z: 1,
    } : null;
    const forecastBandSeries = projection && showForecastRange ? {
      name: `Estimated ${Math.round(projection.confidenceLevel * 100)}% forecast range`,
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.upperBand.map(([time, value], index) => [time, value - projection.lowerBand[index][1]]),
      stack: 'forecast-range',
      showSymbol: false,
      silent: true,
      lineStyle: { opacity: 0 },
      areaStyle: { color: PROJECTION, opacity: 0.1 },
      tooltip: { show: false },
      z: 1,
    } : null;
    const dominancePoints = showDominanceProjection ? (dominanceOutlook?.points.filter((point) => {
      const baseTime = dominanceOutlook ? Date.parse(`${dominanceOutlook.baseDate}T00:00:00.000Z`) : 0;
      const pointTime = Date.parse(`${point.time}T00:00:00.000Z`);
      return pointTime <= baseTime + projectionHorizonDays * DAY_MS;
    }) ?? []) : [];
    const dominanceSeries = dominancePoints.length ? {
      name: `Dominance expiry-decay · next ${projectionHorizonDays} days`,
      type: 'line' as const,
      yAxisIndex: 1,
      data: dominancePoints
        .filter((point) => point.dominance !== null)
        .map((point) => [Date.parse(`${point.time}T00:00:00.000Z`), point.dominance as number]),
      showSymbol: false,
      smooth: 0.38,
      smoothMonotone: 'x' as const,
      lineStyle: { color: DOMINANCE_PROJECTION, width: 2, type: 'dotted' as const },
      itemStyle: { color: DOMINANCE_PROJECTION },
      z: 3,
    } : null;
    const dominanceEnd = dominancePoints.at(-1)?.time
      ? Date.parse(`${dominancePoints.at(-1)!.time}T00:00:00.000Z`)
      : 0;

    const option: echarts.EChartsOption = {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 68, right: 104, top: 34, bottom: 68 },
      legend: {
        show: false,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { backgroundColor: '#1e293b' } },
        backgroundColor: '#0f172a',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0' },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params as Array<{ axisValue: number; value: unknown }> : [];
          const at = list[0]?.axisValue;
          if (!at) return '';
          const wallsAtTime = visibleWalls.filter((wall) => {
            const t = new Date(wall.from).getTime();
            const end = wallChartEnd(wall);
            return at >= t && at <= end;
          }).sort((a, b) => oiForWall(b, wallMode) - oiForWall(a, wallMode)).slice(0, 4);
          const lines = [`<b>${formatTime(new Date(at).toISOString(), displayTimezone)}</b>`];
          const bar = visiblePrice.find((item) => item.time === new Date(at).toISOString());
          if (bar) {
            const plottedValue = chartPriceValue(bar, priceMode);
            lines.push(`${chartPriceLabel(priceMode)}: <b>$${plottedValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`);
            lines.push(`<span style="color:${bar.isClosed ? '#94a3b8' : '#facc15'}">${bar.isClosed ? 'Closed bar' : 'Current open bar · latest source value'}</span>`);
            if (priceMode === 'mean') lines.push(`<span style="color:#94a3b8">Close reference: $${bar.close.toLocaleString()}</span>`);
          }
          const projectionIndex = projection?.data.findIndex(([time]) => time === at) ?? -1;
          const projectionPoint = projectionIndex >= 0 ? projection?.data[projectionIndex] : undefined;
          if (!bar && at > lastActualTime && projectionPoint) {
            const lower = projection?.lowerBand[projectionIndex]?.[1];
            const upper = projection?.upperBand[projectionIndex]?.[1];
            const leadingModel = projection?.modelScores[0];
            const modelLabel = leadingModel
              ? leadingModel.name + ' ' + Math.round(leadingModel.weight * 100) + '%'
              : 'ensemble';
            lines.push(`<span style="color:${PROJECTION}">Forecast: <b>$${projectionPoint[1].toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> · ${projection?.regime ?? 'range'} regime</span>`);
            lines.push(`<span style="color:#fdba74">Rolling-origin ensemble · ${modelLabel} lead · validation MAE $${projection?.backtestMae.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>`);
            if (showForecastRange && lower !== undefined && upper !== undefined) {
              lines.push(`<span style="color:#fdba74">Estimated ${Math.round((projection?.confidenceLevel ?? 0.8) * 100)}% range: $${lower.toLocaleString(undefined, { maximumFractionDigits: 0 })}–$${upper.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>`);
            }
          }
          const optionsIndex = projection?.optionsData?.findIndex(([time]) => time === at) ?? -1;
          const optionsPoint = optionsIndex >= 0 ? projection?.optionsData?.[optionsIndex] : undefined;
          if (!bar && at > lastActualTime && optionsPoint && optionsPrediction) {
            const targetLabel = optionsPrediction.scenario.targetPrice === null
              ? 'n/a'
              : '$' + optionsPrediction.scenario.targetPrice.toLocaleString(undefined, { maximumFractionDigits: 0 });
            lines.push(`<span style="color:#38bdf8">Options-aware guide: <b>$${optionsPoint[1].toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> Â· target ${targetLabel}</span>`);
            lines.push(`<span style="color:#7dd3fc">${optionsPrediction.scenario.label} · nearest Max Pain ${optionsPrediction.maxPain.nearestStrike?.toLocaleString() ?? 'n/a'} · Gamma ${optionsPrediction.gamma.regime}</span>`);
          }
          const dominancePoint = dominanceOutlook?.points.find((point) => point.time === new Date(at).toISOString().slice(0, 10));
          if (!bar && at > lastActualTime && dominancePoint?.dominance !== null && dominancePoint?.dominance !== undefined) {
            lines.push(`<span style="color:${DOMINANCE_PROJECTION}">Expiry-decay dominance: <b>${(dominancePoint.dominance * 100).toFixed(0)}%</b> · ${dominancePoint.activeExpiryCount} expiries</span>`);
          }
          if (wallsAtTime.length > 0) {
            lines.push('<br/><span style="color:#94a3b8">Top OI walls</span>');
            for (const wall of wallsAtTime) {
              const expiryState = wallExpiryState(wall, wallReferenceTime);
              const tooltipSide = wallMode === 'call' ? 'call' : wallMode === 'put' ? 'put' : 'combined';
              const color = wallColor(wall, expiryState, tooltipSide);
              const tooltipOi = wallMode === 'split' ? wall.totalOi : oiForWall(wall, wallMode);
              const oiLabelSuffix = tooltipOi >= HIGH_OI_THRESHOLD ? ' · high OI' : '';
              const expiryLabel = expiryState;
              const oiLabel = wallMode === 'call'
                ? `C ${wall.callOi.toLocaleString()}`
                : wallMode === 'put'
                  ? `P ${wall.putOi.toLocaleString()}`
                  : wallMode === 'split'
                    ? `C ${wall.callOi.toLocaleString()} / P ${wall.putOi.toLocaleString()}`
                    : `OI ${wall.totalOi.toLocaleString()}`;
              lines.push(`<span style="color:${color}">${wall.strike.toLocaleString()} · ${oiLabel} · D ${(wall.dominance * 100).toFixed(0)}% · ${expiryLabel}${oiLabelSuffix}</span>`);
            }
          }
          return lines.join('<br/>');
        },
      },
      xAxis: {
        type: 'time',
        boundaryGap: [0, 0],
        axisLabel: { color: '#94a3b8', hideOverlap: true },
        axisLine: { lineStyle: { color: '#334155' } },
        splitLine: { show: false },
        min: priceTimes[0],
        max: Math.max(projection?.end ?? priceTimes[priceTimes.length - 1], dominanceEnd, maxWallEnd),
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          name: priceMode === 'mean' ? 'Mean $/oz' : 'Futures $/oz',
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8', formatter: (value: number) => `$${value.toLocaleString()}` },
          axisLine: { lineStyle: { color: '#475569' } },
          splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.35)' } },
        },
        {
          type: 'value',
          min: -1,
          max: 1,
          name: 'Put / Call dominance',
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8', formatter: (value: number) => `${value > 0 ? '+' : ''}${Math.round(value * 100)}%` },
          axisLine: { lineStyle: { color: '#64748b' } },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
        { type: 'slider', xAxisIndex: 0, height: 22, bottom: 14, borderColor: '#334155', backgroundColor: '#111827', fillerColor: 'rgba(94, 234, 212, 0.16)', handleStyle: { color: '#5eead4' }, textStyle: { color: '#94a3b8' } },
        { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true },
        { type: 'slider', yAxisIndex: 0, orient: 'vertical', width: 16, right: 10, top: 34, bottom: 68, borderColor: '#334155', backgroundColor: '#111827', fillerColor: 'rgba(250, 204, 21, 0.16)', handleStyle: { color: '#facc15' }, textStyle: { color: '#94a3b8' }, showDetail: false },
      ],
      series: [
        ...(forecastBandBaseline ? [forecastBandBaseline] : []),
        ...(forecastBandSeries ? [forecastBandSeries] : []),
        {
          name: chartPriceLabel(priceMode),
          type: 'line',
          yAxisIndex: 0,
          data: visiblePrice.map((bar) => [new Date(bar.time).getTime(), chartPriceValue(bar, priceMode)]),
          showSymbol: false,
          smooth: 0.58,
          smoothMonotone: 'x',
          lineStyle: { color: '#facc15', width: 2.2, cap: 'round', join: 'round', shadowBlur: 2, shadowColor: 'rgba(250, 204, 21, 0.28)' },
          itemStyle: { color: '#facc15' },
          z: 6,
          markLine: {
            symbol: ['none', 'none'],
            silent: true,
            lineStyle: { color: '#64748b', width: 1, type: 'dashed' },
            label: { color: '#cbd5e1', backgroundColor: '#1e293b', padding: [3, 5], formatter: (params: any) => params.data?.name ?? '' },
            data: [
              ...rolls.map((roll) => ({ xAxis: new Date(roll.time).getTime(), name: `${roll.fromContract} → ${roll.toContract}` })),
              ...(optionsPrediction?.maxPain.compositeStrike ? [{ yAxis: optionsPrediction.maxPain.compositeStrike, name: `90D composite pain $${optionsPrediction.maxPain.compositeStrike.toLocaleString()}`, lineStyle: { color: '#fb923c', width: 1.5, type: 'dashed' as const }, label: { position: 'insideStartTop' as const } }] : []),
              ...(optionsPrediction?.gamma.flipStrike ? [{ yAxis: optionsPrediction.gamma.flipStrike, name: `Gamma flip $${optionsPrediction.gamma.flipStrike.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, lineStyle: { color: '#38bdf8', width: 1.5, type: 'dotted' as const }, label: { position: 'insideStartTop' as const } }] : []),
            ],
          },
        },
        ...(projectionSeries ? [projectionSeries] : []),
        ...(optionsScenarioSeries ? [optionsScenarioSeries] : []),
        ...(dominanceSeries ? [dominanceSeries] : []),
        ...wallSeries,
      ],
    };
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [displayTimezone, dominanceOutlook, optionsPrediction, priceMode, projection, projectionHorizonDays, rolls, showDominanceProjection, showForecastRange, visiblePrice, visibleWalls, wallMode, timeframe]);

  return <div ref={containerRef} className="chart-canvas" aria-label={`GC ${timeframe} ${priceMode === 'mean' ? 'mean' : 'close'} price chart with OI wall overlay`} />;
}
