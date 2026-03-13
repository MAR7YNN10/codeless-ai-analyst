import React from "react";
import Plot from "react-plotly.js";
import ReactECharts from "echarts-for-react"; // THE NEW ENTERPRISE UI ENGINE

// Professional palette to ensure every slice/bar has a unique color
const DASHBOARD_COLORS = [
  '#4e73df', '#1cc88a', '#36b9cc', '#f6c23e', '#e74a3b', 
  '#858796', '#6610f2', '#e83e8c', '#fd7e14', '#20c9a6'
];

export default function ChartRenderer({ chart }) {
  if (!chart) return null;

  const layoutTitle = chart.generated_title || "Data Analysis";

  // =========================================================================
  // THE TRAFFIC COP: ROUTE "BI CHARTS" TO ECHARTS
  // =========================================================================
  const biCharts = ["bar", "line", "pie", "donut", "funnel"];
  const isBIChart = chart.labels && chart.datasets && biCharts.includes(chart.type);

  if (isBIChart) {
    let option = {
      title: { text: layoutTitle, left: 'center', textStyle: { color: '#333', fontSize: 18, fontWeight: 'bold' } },
      tooltip: { trigger: chart.type === 'pie' || chart.type === 'funnel' ? 'item' : 'axis', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: 8 },
      legend: { bottom: 0, textStyle: { color: '#666' } },
      color: DASHBOARD_COLORS,
      animationDuration: 1500,
      animationEasing: 'cubicInOut'
    };

    // --- ECHARTS: BAR & LINE TEMPLATES ---
    if (chart.type === 'bar' || chart.type === 'line') {
      option.grid = { left: '5%', right: '5%', bottom: '10%', containLabel: true };
      option.xAxis = { 
        type: 'category', 
        data: chart.labels,
        axisLine: { lineStyle: { color: '#ccc' } },
        axisLabel: { color: '#666', rotate: chart.labels.length > 5 ? 45 : 0 }
      };
      option.yAxis = { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#eee' } } };
      
      option.series = chart.datasets.map(ds => ({
        name: ds.label || 'Value',
        data: ds.data,
        type: chart.type === 'line' ? 'line' : 'bar',
        smooth: true, // Beautiful curved lines
        itemStyle: chart.type === 'bar' ? { borderRadius: [5, 5, 0, 0] } : {}, // Rounded bar tops
        areaStyle: chart.type === 'line' ? { opacity: 0.1 } : null // Adds a sleek shadow under the line
      }));
    } 
    // --- ECHARTS: PIE & DONUT TEMPLATES ---
    else if (chart.type === 'pie' || chart.type === 'donut') {
      option.series = chart.datasets.map(ds => ({
        name: ds.label || 'Value',
        type: 'pie',
        radius: chart.hole || chart.type === 'donut' ? ['40%', '70%'] : '60%',
        center: ['50%', '45%'],
        itemStyle: { borderRadius: 8, borderColor: '#fff', borderWidth: 2 }, // Separates slices cleanly
        data: chart.labels.map((label, i) => ({ name: label, value: ds.data[i] }))
      }));
    }
    // --- ECHARTS: FUNNEL TEMPLATE ---
    else if (chart.type === 'funnel') {
      option.series = chart.datasets.map(ds => ({
        name: ds.label || 'Value',
        type: 'funnel',
        left: '10%', top: 60, bottom: 60, width: '80%',
        sort: 'descending',
        data: chart.labels.map((label, i) => ({ name: label, value: ds.data[i] }))
      }));
    }

    return (
      <div style={{ width: '100%', height: '550px', padding: '10px', background: '#fff', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
        <ReactECharts 
          option={option} 
          style={{ height: '550px', width: '100%' }} /* <-- Changed 100% to 550px */
          notMerge={true} 
          lazyUpdate={true} 
        />
      </div>
    );
  }

  // =========================================================================
  // PATH B: FALLBACK TO PLOTLY FOR DATA SCIENCE & 3D CHARTS
  // =========================================================================
  let plotData = [];
  
  if (chart.type) {
    let trace = { ...chart };

    if (trace.type === "3d_scatter") trace.type = "scatter3d";
    if (trace.type === "radar" || trace.type === "scatterpolar") { 
        trace.type = "scatterpolar"; 
        trace.fill = "toself"; 
    }

    if (trace.type === "scatter" || trace.type === "scatter3d") {
      if (!trace.fill) trace.mode = "markers";
      trace.marker = {
        size: chart.marker_size || (trace.type === "scatter3d" ? 5 : 8),
        color: chart.z || chart.y,
        colorscale: "Viridis",
        showscale: !!chart.z || !!chart.marker_size 
      };
    }
    
    if (trace.type === "heatmap") trace.colorscale = "YlOrRd";

    plotData = [trace];
  }

  const layout = {
    title: { text: layoutTitle, font: { size: 18, color: '#333' } }, // Updated to match ECharts light mode
    autosize: true,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#333' },
    margin: { l: 60, r: 40, b: 60, t: 60 },
    xaxis: { gridcolor: '#eee', zerolinecolor: '#ccc' },
    yAxis: { gridcolor: '#eee', zerolinecolor: '#ccc' },
    scene: {
      xaxis: { title: 'X Axis', gridcolor: '#eee', backgroundcolor: 'rgba(0,0,0,0)' },
      yaxis: { title: 'Y Axis', gridcolor: '#eee', backgroundcolor: 'rgba(0,0,0,0)' },
      zaxis: { title: 'Z Axis', gridcolor: '#eee', backgroundcolor: 'rgba(0,0,0,0)' },
    }
  };

  return (
    <div style={{ width: '100%', height: '550px', padding: '10px', background: '#fff', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
      <Plot
        data={plotData}
        layout={layout}
        useResizeHandler={true}
        style={{ width: "100%", height: "100%" }}
        config={{ responsive: true, displayModeBar: true, displaylogo: false }}
      />
    </div>
  );
}