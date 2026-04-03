/**
 * apps-script-template.ts
 *
 * Template do Apps Script para sincronização do Log de Testes de Criativos.
 * Usado por POST /api/setup/apps-script para implantar via Apps Script API.
 *
 * Placeholders substituídos em runtime:
 *   {{SPREADSHEET_ID}}  — ID da planilha Google Sheets
 *   {{API_KEY}}         — Valor de TEST_LOG_API_KEY (salvo em Script Properties)
 *   {{API_BASE}}        — Base URL do app (ex: https://pegasus-ads.vercel.app)
 */

export const APPS_SCRIPT_TEMPLATE = `
/**
 * sync_test_log.gs — Pegasus Ads · Log de Testes
 * Implantado automaticamente por POST /api/setup/apps-script
 * NÃO EDITAR MANUALMENTE — regenerar via Pegasus Ads.
 */

// ── Configuração ───────────────────────────────────────────────────────────────

var SPREADSHEET_ID = '{{SPREADSHEET_ID}}';
var API_BASE       = '{{API_BASE}}';
var API_PATH       = '/api/export/test-log';
var CPL_TARGET     = 25.0;

// API key armazenada em Script Properties (mais seguro que hardcode)
function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key) {
    // Fallback: inicializar se ainda não estiver definido
    PropertiesService.getScriptProperties().setProperty('API_KEY', '{{API_KEY}}');
    key = '{{API_KEY}}';
  }
  return key;
}

// Colunas da aba Criativos (1-indexed)
var COL = {
  NOME:        1,
  TIPO:        2,
  IA:          3,
  PARCERIA:    4,
  CAMPANHAS:   5,
  ADSETS:      6,
  SPEND:       7,
  IMPRESSOES:  8,
  CPM:         9,
  CTR:         10,
  CLIQUES:     11,
  LPV:         12,
  CONNECT:     13,
  LEADS:       14,
  CPL:         15,
  CONV:        16,
  VEREDITO:    17,
  HIPOTESE:    18,
  APRENDIZADO: 19
};

var VEREDICTOS_AUTO = ['Kill L0', 'Kill L1', 'Kill L2', 'Kill L3', 'Kill L4', 'Em teste'];

var COR_VEREDITO = {
  'Vencedor':    { bg: '#C6EFCE', fg: '#276221' },
  'Kill L0':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Kill L1':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Kill L2':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Kill L3':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Kill L4':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Ruim':        { bg: '#FFC7CE', fg: '#9C0006' },
  'Em teste':    { bg: '#BDD7EE', fg: '#1F4E79' },
  'Caro':        { bg: '#FFEB9C', fg: '#9C6500' },
  'Aceitável':   { bg: '#FFEB9C', fg: '#9C6500' },
  'Sem dados':   { bg: '#D9D9D9', fg: '#3F3F3F' },
  'Em andamento':{ bg: '#BDD7EE', fg: '#1F4E79' }
};

// ── Ponto de entrada ───────────────────────────────────────────────────────────

function syncAll() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var log = [];

  try {
    var data = fetchApiData_();
    if (!data) {
      ss.toast('Erro ao buscar dados da API Pegasus Ads.', 'Pegasus Ads — Erro', 10);
      return;
    }

    log.push('API: ' + data.criativos.length + ' criativos');

    var statsCriativos = syncCriativos_(ss, data.criativos, data.cpl_target);
    log.push('Criativos: ' + statsCriativos.updated + ' atualizados, ' +
             statsCriativos.added + ' novos, ' +
             statsCriativos.killApplied + ' kill rules');

    var countBrutos = syncDadosBrutos_(ss, data.dados_brutos);
    log.push('Dados Brutos: ' + countBrutos + ' linhas');

    updateTimestamp_(ss, data.cpl_target);

    var summary = log.join(' | ');
    Logger.log(summary);
    ss.toast(summary, 'Pegasus Ads — Sync concluído', 5);

  } catch (e) {
    Logger.log('ERRO: ' + e.message);
    ss.toast('Erro: ' + e.message, 'Pegasus Ads — Sync falhou', 10);
    throw e;
  }
}

// ── Buscar dados da API ────────────────────────────────────────────────────────

function fetchApiData_() {
  var url = API_BASE + API_PATH + '?date_from=' + getDateFrom_(90);
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-api-key': getApiKey_()
      },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('API error: ' + response.getResponseCode() + ' ' + response.getContentText());
      return null;
    }
    return JSON.parse(response.getContentText());
  } catch (e) {
    Logger.log('Fetch error: ' + e.message);
    return null;
  }
}

// ── Sync aba Criativos ────────────────────────────────────────────────────────

function syncCriativos_(ss, criativos, cplTarget) {
  var ws = ss.getSheetByName('Criativos');
  var stats = { updated: 0, added: 0, killApplied: 0 };

  var lastRow = ws.getLastRow();
  var allData = lastRow > 1
    ? ws.getRange(2, 1, lastRow - 1, COL.APRENDIZADO).getValues()
    : [];

  var existingMap = {};
  for (var i = 0; i < allData.length; i++) {
    var nome = String(allData[i][COL.NOME - 1] || '').trim();
    if (nome) existingMap[nome] = i;
  }

  var apiMap = {};
  for (var j = 0; j < criativos.length; j++) {
    apiMap[criativos[j].nome] = criativos[j];
  }

  // Atualizar linhas existentes
  for (var nome in existingMap) {
    if (!apiMap[nome]) continue;
    var m = apiMap[nome];
    if (!m.spend || m.spend === 0) continue;

    var rowIdx = existingMap[nome];
    var sheetRow = rowIdx + 2;

    ws.getRange(sheetRow, COL.SPEND).setValue(m.spend);
    ws.getRange(sheetRow, COL.IMPRESSOES).setValue(m.impressoes);
    ws.getRange(sheetRow, COL.CPM).setValue(m.cpm);
    ws.getRange(sheetRow, COL.CTR).setValue(m.ctr);
    ws.getRange(sheetRow, COL.CLIQUES).setValue(m.cliques);
    ws.getRange(sheetRow, COL.LEADS).setValue(m.leads);
    ws.getRange(sheetRow, COL.CPL).setValue(m.cpl !== null ? m.cpl : '');

    colorCplCell_(ws.getRange(sheetRow, COL.CPL), m.cpl, cplTarget);

    if (m.kill_rule) {
      var vereCell = ws.getRange(sheetRow, COL.VEREDITO);
      var vereAtual = String(vereCell.getValue() || '').trim();
      if (!vereAtual || VEREDICTOS_AUTO.indexOf(vereAtual) !== -1) {
        var vereLabel = m.kill_rule.action === 'kill'
          ? 'Kill ' + m.kill_rule.level
          : m.kill_rule.action === 'promote'
          ? 'Vencedor'
          : 'Em teste';
        setVeredito_(vereCell, vereLabel);
        stats.killApplied++;
      }
    } else if (m.leads > 0 && !allData[rowIdx][COL.VEREDITO - 1]) {
      setVeredito_(ws.getRange(sheetRow, COL.VEREDITO), 'Em teste');
    }

    stats.updated++;
  }

  // Adicionar novos criativos
  var nextRow = lastRow + 1;
  for (var apiNome in apiMap) {
    if (existingMap.hasOwnProperty(apiNome)) continue;

    var newM = apiMap[apiNome];
    ws.getRange(nextRow, COL.NOME).setValue(newM.nome);
    ws.getRange(nextRow, COL.TIPO).setValue('Imagem');

    if (newM.spend && newM.spend > 0) {
      ws.getRange(nextRow, COL.SPEND).setValue(newM.spend);
      ws.getRange(nextRow, COL.IMPRESSOES).setValue(newM.impressoes);
      ws.getRange(nextRow, COL.CPM).setValue(newM.cpm);
      ws.getRange(nextRow, COL.CTR).setValue(newM.ctr);
      ws.getRange(nextRow, COL.CLIQUES).setValue(newM.cliques);
      ws.getRange(nextRow, COL.LEADS).setValue(newM.leads);
      ws.getRange(nextRow, COL.CPL).setValue(newM.cpl !== null ? newM.cpl : '');
      colorCplCell_(ws.getRange(nextRow, COL.CPL), newM.cpl, cplTarget);

      var novoVeredito = newM.kill_rule
        ? (newM.kill_rule.action === 'kill' ? 'Kill ' + newM.kill_rule.level : 'Em teste')
        : 'Em teste';
      setVeredito_(ws.getRange(nextRow, COL.VEREDITO), novoVeredito);
    } else {
      setVeredito_(ws.getRange(nextRow, COL.VEREDITO), 'Em teste');
    }

    ws.getRange(nextRow, COL.HIPOTESE).setValue('— (novo)');
    ws.getRange(nextRow, COL.APRENDIZADO).setValue('—');

    stats.added++;
    nextRow++;
  }

  return stats;
}

// ── Sync aba Dados Brutos ─────────────────────────────────────────────────────

function syncDadosBrutos_(ss, dadosBrutos) {
  var ws = ss.getSheetByName('Dados Brutos');

  var lastRow = ws.getLastRow();
  if (lastRow > 1) {
    ws.getRange(2, 1, lastRow - 1, ws.getLastColumn()).clearContent();
  }

  if (!dadosBrutos || dadosBrutos.length === 0) return 0;

  var rows = dadosBrutos.map(function(m) {
    return [
      'T7__0003',
      m.nome,
      m.meta_ad_id || '',
      '',
      '',
      m.spend || 0,
      m.impressoes || 0,
      m.cpm || 0,
      m.ctr || 0,
      m.cliques || 0,
      '',
      m.leads || 0,
      m.cpl || '',
      '',
      '',
      'Não',
      'Não',
      'Não'
    ];
  });

  ws.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

// ── Atualizar timestamp ───────────────────────────────────────────────────────

function updateTimestamp_(ss, cplTarget) {
  var ws = ss.getSheetByName('Aprendizados');
  if (!ws) return;
  var data = ws.getDataRange().getValues();
  var hoje = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy');

  for (var i = 0; i < data.length && i < 10; i++) {
    for (var j = 0; j < data[i].length; j++) {
      var val = String(data[i][j] || '');
      if (val.indexOf('Última atualização') !== -1 || val.indexOf('CPL Meta') !== -1) {
        ws.getRange(i + 1, j + 1).setValue(
          'CPL Meta: R$' + cplTarget.toFixed(2) + ' | Última atualização: ' + hoje
        );
        return;
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setVeredito_(cell, veredito) {
  cell.setValue(veredito);
  var cor = COR_VEREDITO[veredito];
  if (cor) {
    cell.setBackground(cor.bg).setFontColor(cor.fg);
  }
}

function colorCplCell_(cell, cpl, cplTarget) {
  if (cpl === null || cpl === undefined || cpl === '') {
    cell.setBackground(null).setFontColor(null);
    return;
  }
  var ratio = cpl / cplTarget;
  if (ratio <= 1.0)       { cell.setBackground('#C6EFCE').setFontColor('#276221'); }
  else if (ratio <= 1.31) { cell.setBackground('#EBFCE8').setFontColor('#276221'); }
  else if (ratio <= 1.97) { cell.setBackground('#FFEB9C').setFontColor('#9C6500'); }
  else if (ratio <= 2.62) { cell.setBackground('#FFC7CE').setFontColor('#9C0006'); }
  else                    { cell.setBackground('#FF0000').setFontColor('#FFFFFF'); }
}

function getDateFrom_(daysBack) {
  var d = new Date();
  d.setDate(d.getDate() - daysBack);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ── Trigger automático ────────────────────────────────────────────────────────

function installTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncAll') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('syncAll')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .inTimezone('America/Sao_Paulo')
    .create();
  SpreadsheetApp.openById(SPREADSHEET_ID)
    .toast('Trigger instalado: sync diário às 7h', 'Pegasus Ads', 5);
}

// ── Menu personalizado ────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pegasus Ads')
    .addItem('🔄  Sincronizar agora', 'syncAll')
    .addSeparator()
    .addItem('⏰  Instalar sync diário (7h)', 'installTrigger')
    .addToUi();
}
`.trim();

/**
 * Injeta os placeholders no template e retorna o script final.
 */
export function buildAppsScript(opts: {
  spreadsheetId: string;
  apiKey: string;
  apiBase?: string;
}): string {
  const base = opts.apiBase ?? "https://pegasus-ads.vercel.app";
  return APPS_SCRIPT_TEMPLATE
    .replace(/\{\{SPREADSHEET_ID\}\}/g, opts.spreadsheetId)
    .replace(/\{\{API_KEY\}\}/g, opts.apiKey)
    .replace(/\{\{API_BASE\}\}/g, base);
}
