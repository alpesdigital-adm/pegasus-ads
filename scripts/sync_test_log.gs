/**
 * sync_test_log.gs — Pegasus Ads · Log de Testes (Tarefa 2.7)
 *
 * Apps Script container-bound na planilha
 * "T7 - Registro de Testes de Criativos" no Google Sheets.
 *
 * SETUP (fazer uma vez):
 *   1. Abrir a planilha → Extensões → Apps Script
 *   2. Colar este arquivo inteiro → Salvar
 *   3. Executar "syncAll" manualmente uma vez para autorizar permissões
 *   4. Opcional: Triggers → Adicionar trigger → syncAll · time-driven · a cada 1 hora
 *
 * O script busca dados de: https://pegasus-ads.vercel.app/api/export/test-log
 * e atualiza as três abas sem precisar de OAuth ou upload de arquivo.
 */

// ── Configuração ──────────────────────────────────────────────────────────────

var API_BASE = 'https://pegasus-ads.vercel.app';
var API_PATH = '/api/export/test-log';
var CPL_TARGET = 25.0;

// Colunas da aba Criativos (1-indexed)
var COL = {
  NOME:        1,   // A
  TIPO:        2,   // B
  IA:          3,   // C
  PARCERIA:    4,   // D
  CAMPANHAS:   5,   // E
  ADSETS:      6,   // F
  SPEND:       7,   // G ← atualizar
  IMPRESSOES:  8,   // H ← atualizar
  CPM:         9,   // I ← atualizar
  CTR:         10,  // J ← atualizar
  CLIQUES:     11,  // K ← atualizar
  LPV:         12,  // L   preservar
  CONNECT:     13,  // M   preservar
  LEADS:       14,  // N ← atualizar
  CPL:         15,  // O ← atualizar
  CONV:        16,  // P   preservar
  VEREDITO:    17,  // Q ← atualizar se kill/promote (preservar se manual)
  HIPOTESE:    18,  // R   preservar
  APRENDIZADO: 19   // S   preservar
};

// Veredictos que o script pode sobrescrever (gerados automaticamente)
var VEREDICTOS_AUTO = ['Kill L0', 'Kill L1', 'Kill L2', 'Em teste'];

// Cores dos veredictos (hex sem #)
var COR_VEREDITO = {
  'Vencedor':    { bg: '#C6EFCE', fg: '#276221' },
  'Kill L0':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Kill L1':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Kill L2':     { bg: '#FFC7CE', fg: '#9C0006' },
  'Ruim':        { bg: '#FFC7CE', fg: '#9C0006' },
  'Em teste':    { bg: '#BDD7EE', fg: '#1F4E79' },
  'Caro':        { bg: '#FFEB9C', fg: '#9C6500' },
  'Aceitável':   { bg: '#FFEB9C', fg: '#9C6500' },
  'Sem dados':   { bg: '#D9D9D9', fg: '#3F3F3F' },
  'Em andamento':{ bg: '#BDD7EE', fg: '#1F4E79' }
};

// ── Ponto de entrada principal ────────────────────────────────────────────────

function syncAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = [];

  try {
    // 1. Buscar dados da API
    var data = fetchApiData_();
    if (!data) {
      SpreadsheetApp.getUi().alert('Erro ao buscar dados da API Pegasus Ads.');
      return;
    }

    log.push('✅ API: ' + data.criativos.length + ' criativos, ' + data.dados_brutos.length + ' registros diários');

    // 2. Sincronizar aba Criativos
    var statsCriativos = syncCriativos_(ss, data.criativos, data.cpl_target);
    log.push('📊 Criativos: ' + statsCriativos.updated + ' atualizados, ' +
             statsCriativos.added + ' novos, ' +
             statsCriativos.killApplied + ' kill rules aplicadas');

    // 3. Sincronizar aba Dados Brutos
    var countBrutos = syncDadosBrutos_(ss, data.dados_brutos);
    log.push('📅 Dados Brutos: ' + countBrutos + ' linhas');

    // 4. Atualizar timestamp nos Aprendizados
    updateTimestamp_(ss, data.cpl_target);
    log.push('🕐 Timestamp atualizado');

    // 5. Mostrar resumo no título da planilha por 3s
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
      headers: { 'Accept': 'application/json' },
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

  // Ler todas as linhas existentes de uma vez (mais eficiente que célula a célula)
  var lastRow = ws.getLastRow();
  var allData = lastRow > 1
    ? ws.getRange(2, 1, lastRow - 1, COL.APRENDIZADO).getValues()
    : [];

  // Mapear nome base → índice de linha (0-based no array, row = idx+2)
  var existingMap = {};
  for (var i = 0; i < allData.length; i++) {
    var nome = String(allData[i][COL.NOME - 1] || '').trim();
    if (nome) existingMap[nome] = i;
  }

  // Construir mapa de criativos da API por nome
  var apiMap = {};
  for (var j = 0; j < criativos.length; j++) {
    apiMap[criativos[j].nome] = criativos[j];
  }

  // ── 1. Atualizar linhas existentes ──
  for (var nome in existingMap) {
    if (!apiMap[nome]) continue;
    var m = apiMap[nome];
    if (!m.spend || m.spend === 0) continue;

    var rowIdx = existingMap[nome];
    var sheetRow = rowIdx + 2; // +1 para header, +1 para 1-indexed

    // Atualizar métricas em batch
    ws.getRange(sheetRow, COL.SPEND).setValue(m.spend);
    ws.getRange(sheetRow, COL.IMPRESSOES).setValue(m.impressoes);
    ws.getRange(sheetRow, COL.CPM).setValue(m.cpm);
    ws.getRange(sheetRow, COL.CTR).setValue(m.ctr);
    ws.getRange(sheetRow, COL.CLIQUES).setValue(m.cliques);
    ws.getRange(sheetRow, COL.LEADS).setValue(m.leads);
    ws.getRange(sheetRow, COL.CPL).setValue(m.cpl !== null ? m.cpl : '');

    // Colorir CPL pela distância do target
    colorCplCell_(ws.getRange(sheetRow, COL.CPL), m.cpl, cplTarget);

    // Aplicar kill rule se veredito está em branco ou é auto
    if (m.kill_rule) {
      var vereCell = ws.getRange(sheetRow, COL.VEREDITO);
      var vereAtual = String(vereCell.getValue() || '').trim();
      if (!vereAtual || VEREDICTOS_AUTO.indexOf(vereAtual) !== -1) {
        var vereNovo = m.kill_rule.action === 'promote' ? 'Vencedor' : m.kill_rule.level + ' ' + m.kill_rule.name.split(' ')[0];
        // Simplificar: usar level direto (Kill L0, Kill L1, etc.)
        var vereLabel = m.kill_rule.action === 'kill'
          ? 'Kill ' + m.kill_rule.level
          : m.kill_rule.action === 'promote'
          ? 'Vencedor'
          : 'Em teste';
        setVeredito_(vereCell, vereLabel);
        stats.killApplied++;
      }
    } else if (m.leads > 0 && !allData[rowIdx][COL.VEREDITO - 1]) {
      // Tem leads mas sem kill rule → marcar Em teste se vazio
      setVeredito_(ws.getRange(sheetRow, COL.VEREDITO), 'Em teste');
    }

    stats.updated++;
  }

  // ── 2. Adicionar novos criativos ──
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

  // Limpar dados existentes (mantém linha 1 = header)
  var lastRow = ws.getLastRow();
  if (lastRow > 1) {
    ws.getRange(2, 1, lastRow - 1, ws.getLastColumn()).clearContent();
  }

  if (!dadosBrutos || dadosBrutos.length === 0) return 0;

  // Montar matriz para escrita em batch
  var rows = dadosBrutos.map(function(m) {
    return [
      'T7__0003',            // Campanha
      m.nome,                // Ad Name
      m.meta_ad_id || '',    // Ad ID
      '',                    // Status Ad
      '',                    // Status AdSet
      m.spend || 0,          // Spend
      m.impressoes || 0,     // Impressões
      m.cpm || 0,            // CPM
      m.ctr || 0,            // CTR
      m.cliques || 0,        // Cliques
      '',                    // LPV (não disponível)
      m.leads || 0,          // Leads
      m.cpl || '',           // CPL
      '',                    // Connect Rate
      '',                    // Conv Rate
      'Não',                 // Vídeo
      'Não',                 // IA
      'Não'                  // Parceria
    ];
  });

  ws.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

// ── Atualizar timestamp ───────────────────────────────────────────────────────

function updateTimestamp_(ss, cplTarget) {
  var ws = ss.getSheetByName('Aprendizados');
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
  if (ratio <= 1.0)       { cell.setBackground('#C6EFCE').setFontColor('#276221'); } // verde
  else if (ratio <= 1.31) { cell.setBackground('#EBFCE8').setFontColor('#276221'); } // verde claro
  else if (ratio <= 1.97) { cell.setBackground('#FFEB9C').setFontColor('#9C6500'); } // amarelo
  else if (ratio <= 2.62) { cell.setBackground('#FFC7CE').setFontColor('#9C0006'); } // laranja/vermelho
  else                    { cell.setBackground('#FF0000').setFontColor('#FFFFFF'); } // vermelho forte
}

function getDateFrom_(daysBack) {
  var d = new Date();
  d.setDate(d.getDate() - daysBack);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ── Trigger automático (instalar via menu ou manualmente) ─────────────────────

function installTrigger() {
  // Remove triggers existentes para este script
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncAll') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Criar trigger: todo dia às 7h (horário de São Paulo)
  ScriptApp.newTrigger('syncAll')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .inTimezone('America/Sao_Paulo')
    .create();
  SpreadsheetApp.getActiveSpreadsheet()
    .toast('Trigger instalado: sync diário às 7h', 'Pegasus Ads', 5);
}

// ── Menu personalizado na planilha ────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pegasus Ads')
    .addItem('🔄  Sincronizar agora', 'syncAll')
    .addSeparator()
    .addItem('⏰  Instalar sync diário (7h)', 'installTrigger')
    .addToUi();
}
