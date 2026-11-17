// Abre o painel lateral ao clicar no ícone. Todo o trabalho pesado acontece
// no painel, que é uma página de extensão de verdade: sobrevive ao service
// worker hibernar e pode usar blob URLs e fetch cross-origin.

// Só o objeto: aplicarMarca() mexe em document, que não existe aqui no
// service worker. Importar o módulo é inofensivo — nada dele roda sozinho.
import { MARCA } from './marca.js';

const MENU_ID = 'clonasite-clone-page';
const PANEL = 'panel.html';
const hasSidePanel = () => !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);

// No topo, e não só dentro de onInstalled: depois que o Chrome reinicia o
// service worker acorda sem disparar onInstalled, e o clique no ícone ficaria
// sem dono. Chamar de novo é inofensivo.
if (hasSidePanel()) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Registra o caminho em tempo de execução também. O default_path do manifest
  // deveria bastar, mas quando o Chrome carrega a extensão de um caminho que ele
  // não resolve bem (acento, OneDrive) é este setOptions que salva o painel.
  if (chrome.sidePanel.setOptions) {
    chrome.sidePanel.setOptions({ path: PANEL, enabled: true }).catch(() => {});
  }
}

async function openUi(tab) {
  if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch {
      // sem gesto do usuário, versão antiga, ou painel indisponível
    }
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL) });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Clonar esta página com o ' + MARCA.nome,
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });
});

// Só dispara quando o painel lateral não assumiu o clique — com ele, o próprio
// Chrome abre o painel e este evento não chega aqui.
chrome.action.onClicked.addListener(openUi);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) openUi(tab);
});
