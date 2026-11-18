const form = document.querySelector('#generateForm');
const submitBtn = document.querySelector('#submitBtn');
const formMsg = document.querySelector('#formMsg');
const historyEl = document.querySelector('#history');
const refreshBtn = document.querySelector('#refreshBtn');
const refreshIntervalEl = document.querySelector('#refreshInterval');
const modal = document.querySelector('#modal');
const modalBody = document.querySelector('#modalBody');

let pollTimer = null;
let currentPage = 1;
let currentPagination = null;
let savedIpMap = new Map();
let lookedUpIpIds = new Set();
let isLoadingHistory = false;
let hasActiveQwen = false;
let qwenDetailId = null;
const QWEN_MODEL = 'qwen-image-2.1';
const refreshSettings = loadRefreshSettings();
const IPMPT_API = '/api/ipmpt';
const IPMPT_MODEL = 'OpenAI - Codex';
const IPMPT_SOURCE = 'Imagen';

function loadRefreshSettings() {
  const interval = Number(localStorage.getItem('imagen_refresh_interval') || 0);
  return { interval: [0, 5000, 10000, 30000, 60000].includes(interval) ? interval : 0 };
}
function saveRefreshSettings() {
  localStorage.setItem('imagen_refresh_interval', String(refreshSettings.interval));
}
function applyRefreshControls() {
  refreshIntervalEl.value = String(refreshSettings.interval);
}

function fmtDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
}
function fmtMs(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
function statusLabel(status) {
  return { queued: '대기', running: '생성중', done: '완료', error: '실패' }[status] || status;
}
function qwenProgress(item) {
  if (item.imageModel !== QWEN_MODEL || !['queued', 'running'].includes(item.status)) return '';
  const queue = item.queuePosition > 0 ? ` · 대기 ${item.queuePosition}번째` : '';
  const stage = { queued: '대기 중', generating: '맥에서 이미지 생성 중', running: '맥에서 이미지 생성 중' }[item.stage] || item.stage || statusLabel(item.status);
  return `${stage}${queue} · ${item.estimatedTime || '생성 제한 2시간'}`;
}
function updateModelControls() {
  const qwen = form.imageModel.value === QWEN_MODEL;
  form.model.disabled = qwen;
  form.model.closest('.field').hidden = qwen;
  form.imageModel.closest('.field').classList.toggle('qwenModelField', qwen);
  document.querySelector('#qwenOptions').hidden = !qwen;
  document.querySelector('#qwenHint').hidden = !qwen;
  form.negative.disabled = !qwen;
  form.seed.disabled = !qwen;
  for (const option of form.size.options) {
    const compatible = option.value === 'auto' || option.value.split('x').map(Number).every((n) => n >= 256 && n <= 2048 && n % 32 === 0);
    option.disabled = qwen ? !compatible : option.hasAttribute('data-qwen-only');
    option.hidden = option.hasAttribute('data-qwen-only') && !qwen;
  }
  if (form.size.selectedOptions[0]?.disabled) form.size.value = 'auto';
}
async function copyText(text, button) {
  await navigator.clipboard.writeText(text || '');
  const original = button.textContent;
  button.textContent = '복사됨';
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshSavedState(items) {
  const visibleDoneIds = new Set(items.filter((x) => x.status === 'done' && x.imageUrl).map((x) => x.id));
  const idsToLookup = [...visibleDoneIds].filter((id) => !lookedUpIpIds.has(id));
  if (idsToLookup.length === 0) return;

  const pairs = await Promise.all(idsToLookup.map(async (id) => {
    try {
      const data = await fetch(`${IPMPT_API}/lookup?sourceSite=imagen&sourceId=${encodeURIComponent(id)}`).then((r) => r.json());
      return [id, Boolean(data.saved)];
    } catch {
      return [id, false];
    }
  }));

  for (const [id, saved] of pairs) {
    lookedUpIpIds.add(id);
    savedIpMap.set(id, saved);
  }
}

function renderHistory(items, pagination) {
  hasActiveQwen = items.some((item) => item.imageModel === QWEN_MODEL && ['queued', 'running'].includes(item.status));
  currentPagination = pagination;
  currentPage = pagination?.page || currentPage;
  const cards = items.length ? items.map(renderCard).join('') : '<p class="empty">아직 생성 기록이 없습니다.</p>';
  historyEl.innerHTML = `${cards}${renderPager(pagination)}`;
  historyEl.querySelectorAll('[data-id]').forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
  historyEl.querySelectorAll('[data-retry-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      retryJob(button.dataset.retryId, button);
    });
  });
  historyEl.querySelectorAll('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteJob(button.dataset.deleteId, button);
    });
  });
  historyEl.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => loadHistory(Number(button.dataset.page)));
  });
  ensurePolling();
}
function renderPager(pagination) {
  if (!pagination || pagination.totalPages <= 1) return '';
  const { page, totalPages, total, hasPrev, hasNext } = pagination;
  return `<nav class="pager" aria-label="히스토리 페이지">
    <button class="ghost" type="button" data-page="${page - 1}" ${hasPrev ? '' : 'disabled'}>이전</button>
    <span>${page} / ${totalPages} · 전체 ${total}개</span>
    <button class="ghost" type="button" data-page="${page + 1}" ${hasNext ? '' : 'disabled'}>다음</button>
  </nav>`;
}
function renderCard(item) {
  const thumb = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="생성 이미지" loading="lazy">`
    : `<div class="placeholder">${item.status === 'error' ? '!' : '…'}</div>`;
  const retry = item.status === 'error' ? `<button class="miniBtn" type="button" data-retry-id="${item.id}">재시도</button>` : '';
  const saved = savedIpMap.get(item.id) ? '<span class="savedMark">IPMPT 저장됨</span>' : '';
  const remove = (item.status === 'done' || item.status === 'error') ? `<button class="miniBtn danger" type="button" data-delete-id="${item.id}">삭제</button>` : '';
  const errorLine = item.status === 'error' && item.error ? `<p class="errorText">${escapeHtml(item.error)}</p>` : '';
  return `<article class="card ${item.status}" data-id="${item.id}">
    <div class="thumb">${thumb}</div>
    <div class="meta">
      <div class="line"><span class="badge">${statusLabel(item.status)}</span><span>${fmtMs(item.elapsedMs)}</span></div>
      <p class="prompt">${escapeHtml(item.promptPreview)}</p>
      ${errorLine}
      ${qwenProgress(item) ? `<p class="sub" role="status">${escapeHtml(qwenProgress(item))}</p>` : ''}
      <p class="sub">${fmtDate(item.createdAt)} · ${escapeHtml(item.imageModel || '-')} · ${escapeHtml(item.model || '-')} · ${escapeHtml(item.size || 'auto')}</p>
      <div class="cardActions">${saved}${retry}${remove}</div>
    </div>
  </article>`;
}

async function loadHistory(page = currentPage) {
  if (isLoadingHistory) return;
  isLoadingHistory = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  try {
    const data = await api(`/api/history?page=${encodeURIComponent(page)}`);
    await refreshSavedState(data.history);
    renderHistory(data.history, data.pagination);
    if (qwenDetailId && !modal.hidden) await openDetail(qwenDetailId);
  } finally {
    isLoadingHistory = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}
function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}
function restartPolling() {
  stopPolling();
  const interval = hasActiveQwen || (qwenDetailId && !modal.hidden) ? 5000 : refreshSettings.interval;
  if (interval <= 0) return;
  pollTimer = setInterval(() => loadHistory(currentPage).catch((error) => { formMsg.textContent = error.message; }), interval);
}
function ensurePolling() {
  restartPolling();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  formMsg.textContent = '백그라운드 생성 작업을 시작합니다…';
  try {
    const body = new FormData(form);
    const data = await api('/api/generate', { method: 'POST', body });
    const keep = { imageModel: form.imageModel.value, model: form.model.value, size: form.size.value };
    form.reset();
    Object.assign(form.imageModel, { value: keep.imageModel });
    Object.assign(form.model, { value: keep.model });
    Object.assign(form.size, { value: keep.size });
    updateModelControls();
    formMsg.textContent = `작업 시작: ${data.entry.id}`;
    await loadHistory(1);
  } catch (error) {
    formMsg.textContent = error.message;
  } finally {
    submitBtn.disabled = false;
  }
});
form.imageModel.addEventListener('change', updateModelControls);
refreshBtn.addEventListener('click', () => loadHistory(currentPage).catch((error) => { formMsg.textContent = error.message; }));
refreshIntervalEl.addEventListener('change', () => {
  refreshSettings.interval = Number(refreshIntervalEl.value);
  saveRefreshSettings();
  restartPolling();
});


function ipmptImageUrl(imageUrl) {
  return String(imageUrl).replace(/^\/images\//, '/ipmpt-images/');
}
async function ipmptApi(path, options) {
  const res = await fetch(`${IPMPT_API}${path.replace(/^\/api/, '')}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `IPMPT HTTP ${res.status}`);
  return data;
}

function ipmptPayload(entry) {
  return {
    promptText: entry.prompt,
    imageUrl: entry.imageUrl,
    generationModel: entry.imageModel === QWEN_MODEL ? 'Qwen-Image 2.1' : IPMPT_MODEL,
    source: IPMPT_SOURCE,
    sourceSite: 'imagen',
    sourceId: entry.id,
    note: entry.responsePrompt || entry.revisedPrompt || ''
  };
}

function renderIpmptInline(entry, isSaved) {
  if (entry.status !== 'done' || !entry.imageUrl) return '';
  return `<section class="ipmptPanel">
    <h3>${isSaved ? 'IPMPT 저장됨' : 'IPMPT 저장'}</h3>
    <p class="sub">생성모델: ${entry.imageModel === QWEN_MODEL ? 'Qwen-Image 2.1' : IPMPT_MODEL} · 출처: ${IPMPT_SOURCE}</p>
    <div class="detailActions">
      <button class="copyBtn" type="button" data-ipmpt-new="true">새 프롬프트 이미지로 저장</button>
      <button class="copyBtn" type="button" data-ipmpt-add="true">기존 프롬프트 이미지에 추가</button>
    </div>
    <div class="ipmptPickerMount"></div>
  </section>`;
}
async function renderIpmptPickerInline(entry, mount) {
  const data = await ipmptApi('/api/prompts');
  mount.innerHTML = `<input class="pickerSearch" placeholder="프롬프트 검색" /><div class="pickerList"></div>`;
  const input = mount.querySelector('.pickerSearch');
  const list = mount.querySelector('.pickerList');
  const render = (q = '') => {
    const needle = q.toLowerCase();
    const prompts = data.prompts.filter((p) => !needle || `${p.title || ''} ${p.text}`.toLowerCase().includes(needle)).slice(0, 30);
    list.innerHTML = prompts.map((p) => {
      const thumb = p.images?.[0]?.imageUrl ? `<img src="${ipmptImageUrl(p.images[0].imageUrl)}" alt="프롬프트 이미지">` : '<span class="pickerNoThumb">-</span>';
      return `<button class="pickerItem" type="button" data-prompt-id="${p.id}">${thumb}<span class="pickerMeta"><b>${escapeHtml(p.title || p.text.slice(0, 60))}</b><span>이미지 ${p.imageCount}개 · ${escapeHtml(p.text.slice(0, 100))}</span></span></button>`;
    }).join('') || '<p class="empty">저장된 프롬프트가 없습니다.</p>';
    list.querySelectorAll('[data-prompt-id]').forEach((button) => button.addEventListener('click', () => saveIpmptAdd(entry, button.dataset.promptId, button)));
  };
  input.addEventListener('input', () => render(input.value));
  render();
}

async function openIpmptSave(id) {
  try {
    const { entry } = await api(`/api/history/${id}`);
    qwenDetailId = entry.imageModel === QWEN_MODEL && ['queued', 'running'].includes(entry.status) ? id : null;
    const scrollTop = modal.hidden ? 0 : modal.querySelector('.dialog').scrollTop;
    if (entry.status !== 'done' || !entry.imageUrl) throw new Error('완료된 이미지만 저장할 수 있습니다.');
    modalBody.innerHTML = `<h2>IPMPT에 저장</h2>
      <img class="detailImg" src="${entry.imageUrl}" alt="저장할 이미지">
      <p class="sub">생성모델: ${IPMPT_MODEL} · 출처: ${IPMPT_SOURCE}</p>
      <div class="detailActions">
        <button class="copyBtn" type="button" data-ipmpt-new="true">새 프롬프트 이미지로 저장</button>
        <button class="copyBtn" type="button" data-ipmpt-add="true">기존 프롬프트 이미지에 추가</button>
      </div>
      <pre>${escapeHtml(entry.prompt)}</pre>`;
    modalBody.querySelector('[data-ipmpt-new]').addEventListener('click', (event) => saveIpmptNew(entry, event.currentTarget));
    modalBody.querySelector('[data-ipmpt-add]').addEventListener('click', () => openIpmptPicker(entry));
    modal.hidden = false;
  } catch (error) {
    formMsg.textContent = error.message;
  }
}
async function saveIpmptNew(entry, button) {
  const original = button.textContent;
  button.disabled = true; button.textContent = '저장 중…';
  try {
    await ipmptApi('/api/import/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ipmptPayload(entry)) });
    lookedUpIpIds.add(entry.id);
    savedIpMap.set(entry.id, true);
    formMsg.textContent = 'IPMPT에 새 프롬프트로 저장했습니다.';
    modal.hidden = true;
    await loadHistory(currentPage);
  } catch (error) {
    formMsg.textContent = error.message;
    button.disabled = false; button.textContent = original;
  }
}
async function openIpmptPicker(entry) {
  const data = await ipmptApi('/api/prompts');
  modalBody.innerHTML = `<h2>기존 프롬프트에 추가</h2>
    <input class="pickerSearch" placeholder="프롬프트 검색" />
    <div class="pickerList"></div>`;
  const input = modalBody.querySelector('.pickerSearch');
  const list = modalBody.querySelector('.pickerList');
  const render = (q = '') => {
    const needle = q.toLowerCase();
    const prompts = data.prompts.filter((p) => !needle || `${p.title || ''} ${p.text}`.toLowerCase().includes(needle)).slice(0, 30);
    list.innerHTML = prompts.map((p) => {
      const thumb = p.images?.[0]?.imageUrl ? `<img src="${ipmptImageUrl(p.images[0].imageUrl)}" alt="프롬프트 이미지">` : '<span class="pickerNoThumb">-</span>';
      return `<button class="pickerItem" type="button" data-prompt-id="${p.id}">${thumb}<span class="pickerMeta"><b>${escapeHtml(p.title || p.text.slice(0, 60))}</b><span>이미지 ${p.imageCount}개 · ${escapeHtml(p.text.slice(0, 100))}</span></span></button>`;
    }).join('') || '<p class="empty">검색 결과가 없습니다.</p>';
    list.querySelectorAll('[data-prompt-id]').forEach((button) => button.addEventListener('click', () => saveIpmptAdd(entry, button.dataset.promptId, button)));
  };
  input.addEventListener('input', () => render(input.value));
  render();
}
async function saveIpmptAdd(entry, promptId, button) {
  const original = button.innerHTML;
  button.disabled = true; button.textContent = '저장 중…';
  try {
    await ipmptApi('/api/import/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ipmptPayload(entry), promptId }) });
    lookedUpIpIds.add(entry.id);
    savedIpMap.set(entry.id, true);
    formMsg.textContent = 'IPMPT 기존 프롬프트에 이미지를 추가했습니다.';
    modal.hidden = true;
    await loadHistory(currentPage);
  } catch (error) {
    formMsg.textContent = error.message;
    button.disabled = false; button.innerHTML = original;
  }
}

async function retryJob(id, button) {
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '재시도 중…';
  }
  try {
    const data = await api(`/api/history/${id}/retry`, { method: 'POST' });
    formMsg.textContent = `재시도 시작: ${data.entry.id}`;
    modal.hidden = true;
    await loadHistory(1);
  } catch (error) {
    formMsg.textContent = error.message;
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function deleteJob(id, button) {
  if (!confirm('이 히스토리와 생성 파일을 삭제할까요?')) return;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '삭제 중…';
  }
  try {
    await api(`/api/history/${id}`, { method: 'DELETE' });
    formMsg.textContent = `삭제 완료: ${id}`;
    modal.hidden = true;
    await loadHistory(currentPage);
  } catch (error) {
    formMsg.textContent = error.message;
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function formatErrorDetails(entry) {
  const details = entry.errorDetails;
  if (!details) return '-';
  return JSON.stringify(details, null, 2);
}

async function openDetail(id) {
  try {
    const { entry } = await api(`/api/history/${id}`);
    const image = entry.imageUrl ? `<img class="detailImg" src="${entry.imageUrl}" alt="생성 이미지">` : '';
    const retryAction = entry.status === 'error' ? '<button class="retryDetail" type="button" data-detail-retry="true">재시도</button>' : '';
    const deleteAction = (entry.status === 'done' || entry.status === 'error') ? '<button class="deleteDetail" type="button" data-detail-delete="true">삭제</button>' : '';
    const isSaved = savedIpMap.get(entry.id);
    modalBody.innerHTML = `<h2>작업 상세</h2>
      <div class="detailActions">${retryAction}${deleteAction}</div>
      ${image}
      ${qwenProgress(entry) ? `<p class="msg" role="status">${escapeHtml(qwenProgress(entry))}</p>` : ''}
      ${renderIpmptInline(entry, isSaved)}
      <dl class="details">
        <dt>상태</dt><dd>${statusLabel(entry.status)}</dd>
        <dt>걸린시간</dt><dd>${fmtMs(entry.elapsedMs)}</dd>
        <dt>생성일</dt><dd>${fmtDate(entry.createdAt)}</dd>
        <dt>이미지 모델</dt><dd>${escapeHtml(entry.imageModel || '-')}</dd>
        <dt>Codex 모델</dt><dd>${escapeHtml(entry.model || '-')}</dd>
        <dt>Provider</dt><dd>${escapeHtml(entry.provider || '-')}</dd>
        <dt>원본 프롬프트</dt><dd>
          <details class="promptBox promptDetails">
            <summary>원본 프롬프트 보기</summary>
            <button class="copyBtn" type="button" data-copy="prompt">프롬프트 복사</button>
            <pre>${escapeHtml(entry.prompt)}</pre>
          </details>
        </dd>
        <dt>응답 프롬프트</dt><dd>
          <details class="promptBox promptDetails">
            <summary>응답 프롬프트 보기</summary>
            <button class="copyBtn" type="button" data-copy="response">응답 프롬프트 복사</button>
            <pre>${escapeHtml(entry.responsePrompt || entry.revisedPrompt || '-')}</pre>
          </details>
        </dd>
        <dt>오류</dt><dd>${escapeHtml(entry.error || '-')}</dd>
        <dt>오류 코드</dt><dd>${escapeHtml(entry.errorCode || entry.errorDetails?.code || '-')}</dd>
        <dt>오류 상세</dt><dd><pre>${escapeHtml(formatErrorDetails(entry))}</pre></dd>
      </dl>`;
    modalBody.querySelector('[data-copy="prompt"]').addEventListener('click', (event) => copyText(entry.prompt, event.currentTarget));
    modalBody.querySelector('[data-copy="response"]').addEventListener('click', (event) => copyText(entry.responsePrompt || entry.revisedPrompt || '', event.currentTarget));
    modalBody.querySelector('[data-detail-retry="true"]')?.addEventListener('click', (event) => retryJob(entry.id, event.currentTarget));
    modalBody.querySelector('[data-detail-delete="true"]')?.addEventListener('click', (event) => deleteJob(entry.id, event.currentTarget));
    modalBody.querySelector('[data-ipmpt-new]')?.addEventListener('click', (event) => saveIpmptNew(entry, event.currentTarget));
    modalBody.querySelector('[data-ipmpt-add]')?.addEventListener('click', () => renderIpmptPickerInline(entry, modalBody.querySelector('.ipmptPickerMount')));
    modal.hidden = false;
    modal.querySelector('.dialog').scrollTop = scrollTop;
    ensurePolling();
  } catch (error) {
    formMsg.textContent = error.message;
  }
}
modal.addEventListener('click', (event) => {
  if (event.target.dataset.close) modal.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') modal.hidden = true;
});

applyRefreshControls();
updateModelControls();
loadHistory().catch((error) => { historyEl.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; applyRefreshControls(); });
