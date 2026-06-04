"use client";

import React, { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Sector,
} from "recharts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DoughnutData {
  name: string;
  value: number;
  color: string;
}

export interface AreaData {
  date: string;
  count: number;
}

// ── Doughnut Chart ───────────────────────────────────────────────────────────

export function DashboardDoughnutChart({
  title,
  data,
  total,
  totalLabel,
}: {
  title: string;
  data: DoughnutData[];
  total: number;
  totalLabel: string;
}) {
  const [activeIndex, setActiveIndex] = React.useState<number | undefined>();

  return (
    <div className="bg-orange-50 rounded-[20px] p-5 border border-orange-100 shadow-[0_2px_12px_rgba(0,0,0,0.02)] flex flex-col h-full transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)] group cursor-default">
      <h3 className="text-[15px] font-bold text-slate-900 tracking-tight mb-4">
        {title}
      </h3>
      
      <div className="flex-1 flex items-center justify-between min-h-[140px]">
        {/* Left: Chart */}
        <div className="relative w-[110px] h-[110px] flex-shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                innerRadius={36}
                outerRadius={52}
                paddingAngle={2}
                dataKey="value"
                stroke="none"
                isAnimationActive={true}
                animationBegin={100}
                animationDuration={1200}
                animationEasing="ease-out"
                onMouseEnter={(_, index) => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(undefined)}
                activeShape={(props: any) => {
                  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill, payload } = props;
                  return (
                    <g>
                      <Sector
                        cx={cx}
                        cy={cy}
                        innerRadius={innerRadius}
                        outerRadius={outerRadius + 4}
                        startAngle={startAngle}
                        endAngle={endAngle}
                        fill={fill}
                        style={{ filter: `drop-shadow(0px 4px 8px ${fill}60)` }}
                      />
                    </g>
                  );
                }}
              >
                {data.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`} 
                    fill={entry.color} 
                    style={{ transition: 'all 0.3s ease', outline: 'none' }}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  borderRadius: "12px",
                  border: "none",
                  boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
                  padding: "8px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
                itemStyle={{ color: "#334155" }}
              />
            </PieChart>
          </ResponsiveContainer>
          
          {/* Center Text Overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-0.5">
            <span className="text-[18px] font-bold text-slate-900 leading-none mb-0.5">
              {total}
            </span>
            <span className="text-[9px] font-medium text-slate-500 uppercase tracking-wider">
              {totalLabel}
            </span>
          </div>
        </div>

        {/* Right: Legend */}
        <div className="flex flex-col gap-2.5 ml-4 flex-1 min-w-0">
          {data.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between text-[12px]">
              <div className="flex items-center gap-2 truncate pr-2 min-w-0">
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: item.color }}
                />
                <span className="font-medium text-slate-600 truncate">
                  {item.name}
                </span>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="font-bold text-slate-900">{item.value}</span>
                <span className="text-[10px] font-medium text-slate-400 w-7 text-right">
                  {total > 0 ? Math.round((item.value / total) * 100) : 0}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Area Chart ───────────────────────────────────────────────────────────────

export function DashboardAreaChart({
  title,
  data,
  color,
  gradientId,
}: {
  title: string;
  data: AreaData[];
  color: string;
  gradientId: string;
}) {
  return (
    <div className="bg-orange-50 rounded-[20px] p-5 border border-orange-100 shadow-[0_2px_12px_rgba(0,0,0,0.02)] flex flex-col transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)] group cursor-default">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[15px] font-bold text-slate-900 tracking-tight">
          {title}
        </h3>
        <div className="px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 text-[12px] font-medium text-slate-600">
          Last 7 days
        </div>
      </div>

      <div className="w-full h-[150px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.2} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: "#64748b", fontWeight: 500 }}
              dy={10}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: "#64748b", fontWeight: 500 }}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                borderRadius: "12px",
                border: "none",
                boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
                padding: "8px 12px",
                fontSize: "13px",
                fontWeight: 600,
              }}
              itemStyle={{ color: "#334155" }}
              cursor={{ stroke: "#e2e8f0", strokeWidth: 1, strokeDasharray: "4 4" }}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke={color}
              strokeWidth={2.5}
              fillOpacity={1}
              fill={`url(#${gradientId})`}
              isAnimationActive={true}
              animationBegin={200}
              animationDuration={1500}
              animationEasing="ease-out"
              activeDot={{ r: 6, fill: color, stroke: "#fff", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
