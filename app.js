(function () {
  'use strict';

  var state = {
    stripeTxns: [],
    xeroTxns: [],
    matchResult: null,
    adjustments: [],
    summary: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setCount(elId, n) {
    var el = $(elId);
    if (el) el.textContent = n ? (n + ' transactions') : '';
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Failed to read file'));
      };
      reader.readAsText(file);
    });
  }

  function showError(message) {
    var el = $('error-banner');
    if (!el) {
      window.alert(message);
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearError() {
    var el = $('error-banner');
    if (el) {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function handleStripeFile(file) {
    clearError();
    readFileAsText(file)
      .then(function (text) {
        state.stripeTxns = parseStripeCsv(text);
        setCount('stripe-count', state.stripeTxns.length);
        maybeEnableRun();
      })
      .catch(function (err) {
        showError('Could not parse Stripe CSV: ' + (err && err.message ? err.message : String(err)));
      });
  }

  function handleXeroFile(file) {
    clearError();
    readFileAsText(file)
      .then(function (text) {
        state.xeroTxns = parseXeroCsv(text);
        setCount('xero-count', state.xeroTxns.length);
        maybeEnableRun();
      })
      .catch(function (err) {
        showError('Could not parse Xero CSV: ' + (err && err.message ? err.message : String(err)));
      });
  }

  function maybeEnableRun() {
    var btn = $('run-match-btn');
    if (!btn) return;
    btn.disabled = !(state.stripeTxns.length && state.xeroTxns.length);
  }

  function wireDropzone(dropId, inputId, onFile) {
    var drop = $(dropId);
    var input = $(inputId);
    if (!drop || !input) return;

    drop.addEventListener('click', function () {
      input.click();
    });

    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.classList.add('dragover');
    });

    drop.addEventListener('dragleave', function () {
      drop.classList.remove('dragover');
    });

    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('dragover');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        onFile(files[0]);
      }
    });

    input.addEventListener('change', function () {
      if (input.files && input.files.length) {
        onFile(input.files[0]);
      }
    });
  }

  function cell(text, opts) {
    var td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    if (opts && opts.className) td.className = opts.className;
    return td;
  }

  function renderMatchedTable(matched) {
    var tbody = $('matched-body');
    if (!tbody) return;
    clearNode(tbody);
    matched.forEach(function (pair) {
      var tr = document.createElement('tr');
      var stripeTxn = pair.stripe || pair.stripeTxn || {};
      var xeroTxn = pair.xero || pair.xeroTxn || {};
      tr.appendChild(cell(stripeTxn.id || stripeTxn.transactionId || ''));
      tr.appendChild(cell(stripeTxn.date || ''));
      tr.appendChild(cell(stripeTxn.amount != null ? stripeTxn.amount : ''));
      tr.appendChild(cell(xeroTxn.amount != null ? xeroTxn.amount : ''));
      tr.appendChild(cell(pair.type || pair.matchType || ''));
      tr.appendChild(cell(pair.discrepancyCents != null ? pair.discrepancyCents : ''));
      tbody.appendChild(tr);
    });
  }

  function renderUnmatchedTable(bodyId, txns) {
    var tbody = $(bodyId);
    if (!tbody) return;
    clearNode(tbody);
    txns.forEach(function (txn) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(txn.id || txn.transactionId || ''));
      tr.appendChild(cell(txn.date || ''));
      tr.appendChild(cell(txn.amount != null ? txn.amount : ''));
      tr.appendChild(cell(txn.currency || ''));
      tbody.appendChild(tr);
    });
  }

  function renderAdjustments(adjustments) {
    var tbody = $('adjustments-body');
    if (!tbody) return;
    clearNode(tbody);
    adjustments.forEach(function (adj) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(adj.date || ''));
      tr.appendChild(cell(adj.description || adj.memo || ''));
      tr.appendChild(cell(adj.amount != null ? adj.amount : ''));
      tr.appendChild(cell(adj.account || ''));
      tbody.appendChild(tr);
    });
  }

  function renderSummary(summary) {
    var map = {
      'summary-matched': summary.matchedCount,
      'summary-exact': summary.exactMatchCount,
      'summary-rounding': summary.roundingMatchCount,
      'summary-unmatched-stripe': summary.unmatchedStripeCount,
      'summary-unmatched-xero': summary.unmatchedXeroCount,
      'summary-adjustments': summary.adjustmentCount,
      'summary-total-adjustment': summary.totalAdjustmentAmount
    };
    Object.keys(map).forEach(function (id) {
      var el = $(id);
      if (el && map[id] != null) el.textContent = String(map[id]);
    });
  }

  function runMatch() {
    clearError();
    try {
      var options = {};
      var maxDiscInput = $('max-discrepancy-input');
      var dateTolInput = $('date-tolerance-input');

      if (maxDiscInput && maxDiscInput.value !== '') {
        options.maxDiscrepancyCents = toMinorUnits(maxDiscInput.value);
      }
      if (dateTolInput && dateTolInput.value !== '') {
        options.dateToleranceDays = parseInt(dateTolInput.value, 10);
      }

      var result = matchTransactions(state.stripeTxns, state.xeroTxns, options);
      state.matchResult = result;

      var adjustments = generateAdjustments(result.matched);
      state.adjustments = adjustments;

      var summary = summarizeReconciliation(result, adjustments);
      state.summary = summary;

      renderMatchedTable(result.matched);
      renderUnmatchedTable('unmatched-stripe-body', result.unmatchedStripe);
      renderUnmatchedTable('unmatched-xero-body', result.unmatchedXero);
      renderAdjustments(adjustments);
      renderSummary(summary);

      var resultsSection = $('results-section');
      if (resultsSection) resultsSection.classList.remove('hidden');
    } catch (err) {
      showError('Reconciliation failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  function exportAdjustmentsCsv() {
    if (!state.adjustments || !state.adjustments.length) return;
    var header = ['date', 'description', 'amount', 'account'];
    var rows = state.adjustments.map(function (adj) {
      return [adj.date || '', adj.description || adj.memo || '', adj.amount != null ? adj.amount : '', adj.account || '']
        .map(function (v) {
          var s = String(v);
          if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
            s = '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        })
        .join(',');
    });
    var csv = [header.join(',')].concat(rows).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'fx-rounding-adjustments.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function init() {
    wireDropzone('stripe-drop', 'stripe-file-input', handleStripeFile);
    wireDropzone('xero-drop', 'xero-file-input', handleXeroFile);

    var runBtn = $('run-match-btn');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.addEventListener('click', runMatch);
    }

    var exportBtn = $('export-adjustments-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportAdjustmentsCsv);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();