const output = document.getElementById('changelogContent');

fetch(chrome.runtime.getURL('CHANGELOG.md'))
  .then((resp) => {
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  })
  .then((text) => {
    output.textContent = text;
  })
  .catch(() => {
    output.textContent = 'Unable to load CHANGELOG.md.';
  });
