'use strict';

const SOIL_GROUPS = [
  { id: 'A', name: '采煤沉陷区湖泥', moisture: 26.4 },
  { id: 'B', name: '煤矸石', moisture: 17.2 },
  { id: 'C', name: '原状土', moisture: 22.4, control: true },
];

if (typeof module === 'object' && module.exports) module.exports = SOIL_GROUPS;
