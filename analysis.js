'use strict';

// Shared calculations for the browser demo and the model endpoint.
const SoilAnalysis = (() => {
  const groupsConfig = typeof module === 'object' && module.exports ? require('./experiment.js') : SOIL_GROUPS;
  const fields = { moisture: 2, temp: 2, co2: 1, ec: 2 };
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const label = (group) => group.control ? `${group.name}（对照）` : group.name;
  const decimals = (n, digits = 1) => n.toFixed(digits);
  const signed = (n, digits = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`;

  function readings(values) {
    return Object.fromEntries(Object.entries(fields).map(([key, count]) => {
      const series = values?.[key];
      if (!Array.isArray(series) || series.length !== count || !series.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)) {
        throw new TypeError('读数无效');
      }
      return [key, series];
    }));
  }

  function snapshotFrom(input) {
    if (!Number.isInteger(input?.time) || input.time < 0 || input.time > 8.64e15 || typeof input.running !== 'boolean' || !Array.isArray(input.columns) || ![1, 15].includes(input.columns.length)) {
      throw new TypeError('土柱快照无效');
    }
    const ids = new Set();
    const columns = input.columns.map((column) => {
      if (typeof column?.id !== 'string' || !/^[ABC]-0[1-5]$/.test(column.id) || ids.has(column.id)) throw new TypeError('土柱编号无效');
      ids.add(column.id);
      const group = groupsConfig.find((item) => item.id === column.id[0]);
      const rule = column.rule;
      if (typeof rule?.due !== 'boolean') throw new TypeError('提醒状态无效');
      let criteria;
      if (rule.type === 'threshold' && [10, 25].includes(rule.depthCm) && Number.isFinite(rule.minVwcPct) && rule.minVwcPct >= 1 && rule.minVwcPct <= 80 && [0, 1, 2, 3].includes(rule.consecutiveBelow)) {
        criteria = { type: 'threshold', depthCm: rule.depthCm, minVwcPct: rule.minVwcPct, consecutiveBelow: rule.consecutiveBelow };
      } else if (rule.type === 'scheduled' && typeof rule.timeUtc8 === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.timeUtc8) && Number.isFinite(rule.amountMl) && rule.amountMl > 0) {
        criteria = { type: 'scheduled', timeUtc8: rule.timeUtc8, amountMl: rule.amountMl };
      } else {
        throw new TypeError('浇水方案无效');
      }
      const last = column.lastIrrigation;
      const lastIrrigation = Number.isFinite(last?.minutesAgo) && last.minutesAgo >= 0 && Number.isFinite(last?.amountMl) && last.amountMl > 0
        ? { minutesAgo: last.minutesAgo, amountMl: last.amountMl } : null;
      return {
        id: column.id, groupId: group.id, substrate: group.name, control: Boolean(group.control),
        current: readings(column.current), change1h: readings(column.change1h),
        irrigation: { ...criteria, due: rule.due }, lastIrrigation,
      };
    });
    return { time: input.time, running: input.running, source: 'simulation', columns };
  }

  function summarize(snapshot) {
    const groups = groupsConfig.flatMap((group) => {
      const columns = snapshot.columns.filter((column) => column.groupId === group.id);
      if (!columns.length) return [];
      return [{
        id: group.id, label: label(group), count: columns.length,
        shallow: mean(columns.map((column) => column.current.moisture[0])),
        deep: mean(columns.map((column) => column.current.moisture[1])),
        co2: mean(columns.map((column) => column.current.co2[0])),
        moistureChange: mean(columns.map((column) => column.change1h.moisture[0])),
        co2Change: mean(columns.map((column) => column.change1h.co2[0])),
      }];
    });
    const due = snapshot.columns.filter((column) => column.irrigation.due);
    const paused = !snapshot.running;
    const headline = paused ? '采集已暂停，以下为最后一次模拟快照' : due.length ? `${due.length} 柱触发浇水提醒` : '当前范围内暂无浇水提醒';
    const findings = [];
    if (due.length) {
      const threshold = due.filter((column) => column.irrigation.type === 'threshold');
      const scheduled = due.filter((column) => column.irrigation.type === 'scheduled');
      if (threshold.length) {
        const evidence = threshold.map(({ id, current, irrigation: { depthCm, minVwcPct } }) => `${id}（${depthCm} cm，${decimals(current.moisture[depthCm === 10 ? 0 : 1])}% / 下限 ${decimals(minVwcPct)}%）`);
        findings.push(`${evidence.join('、')}连续 3 次低于当前设置下限，按该组实验方案核查补水。`);
      }
      if (scheduled.length) findings.push(`${scheduled.map(({ id }) => id).join('、')}已到计划浇水时间。`);
    }
    if (groups.length > 1) {
      const control = groups.find((group) => group.id === 'C');
      const differences = groups.filter((group) => group.id !== control.id).map((group) => `${group.label} ${signed(group.shallow - control.shallow)} 个百分点`);
      findings.push(`当前 10 cm 平均含水率相对原状土（${decimals(control.shallow)}%）的差值为${differences.join('、')}。`);
    } else {
      const [{ lastIrrigation }] = snapshot.columns;
      const [group] = groups;
      findings.push(`近 1 小时，10 cm 含水率变化 ${signed(group.moistureChange)} 个百分点，孔隙气体 CO₂ 变化 ${signed(group.co2Change, 0)} ppm。`);
      if (lastIrrigation) findings.push(`最近一次浇水记录距快照 ${lastIrrigation.minutesAgo} 分钟，记录水量 ${lastIrrigation.amountMl} mL。`);
    }
    findings.push('本次使用模拟读数。SOC 存量变化需结合播种前、收获后的化验数据和干土质量计算。');
    return { headline, findings, groups };
  }

  return { snapshotFrom, summarize };
})();

if (typeof module === 'object' && module.exports) module.exports = SoilAnalysis;

