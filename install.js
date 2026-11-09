/* 홈 화면에 추가 도우미 (설치 버튼·iOS 안내 창). 다른 파일에 기대지 않는다.
   [data-install] 요소는 설치할 수 있을 때만 보이고, 누르면 설치 창(안드로이드·크롬) 또는 안내 창(iOS)이 뜬다.
   이미 홈 화면에서 연 상태(standalone)면 계속 숨는다. 요소가 나중에 그려지면 hyonnieInstall.sync()를 부른다. */
(function () {
  if (window.hyonnieInstall) return;
  var standalone = false;
  try { standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) {}
  var ua = navigator.userAgent || '';
  var ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var deferred = null;
  var installed = false;

  function can() { return !standalone && !installed && (!!deferred || ios); }
  function sync() {
    var els = document.querySelectorAll('[data-install],[data-install-wrap]');
    for (var i = 0; i < els.length; i++) els[i].hidden = !can();
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; sync(); });
  window.addEventListener('appinstalled', function () { installed = true; deferred = null; sync(); });
  document.addEventListener('DOMContentLoaded', function () { css(); sync(); });

  function css() {
    if (document.getElementById('install-css')) return;
    var s = document.createElement('style'); s.id = 'install-css';
    s.textContent = '[data-install][hidden],[data-install-wrap][hidden]{display:none!important}#install-help{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:16px;padding:20px 22px;max-width:min(92vw,360px);background:Canvas;color:CanvasText;font:inherit;line-height:1.6}' +
      '#install-help::backdrop{background:rgba(0,0,0,.35)}#install-help h2{margin:0 0 10px;font-size:1.05rem}#install-help ol{margin:0 0 14px;padding-left:1.3em}' +
      '#install-help li{margin:.35em 0}#install-help button{font:inherit;padding:8px 18px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:transparent;color:inherit;cursor:pointer;min-height:44px}' +
      '#install-help .ib{display:inline-block;padding:0 .4em;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);border-radius:6px;font-size:.9em}';
    document.head.appendChild(s);
  }
  function help() {
    css();
    var d = document.getElementById('install-help');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'install-help'; d.setAttribute('aria-labelledby', 'install-help-t');
      d.innerHTML = '<h2 id="install-help-t">홈 화면에 추가하기</h2><ol>' +
        '<li>사파리 아래(또는 위)의 <span class="ib">공유</span> 단추(□↑)를 눌러요.</li>' +
        '<li>메뉴를 올려서 <b>홈 화면에 추가</b>를 골라요.</li>' +
        '<li>오른쪽 위 <b>추가</b>를 누르면 끝!</li></ol>' +
        '<p style="margin:0 0 14px;font-size:.9em;opacity:.75">크롬·네이버 앱으로 열었다면 사파리에서 다시 열어 주세요.</p>' +
        '<button type="button" autofocus>알겠어요</button>';
      d.querySelector('button').addEventListener('click', function () { d.close(); });
      d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
      document.body.appendChild(d);
    }
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function run() {
    if (deferred) {
      var p = deferred; deferred = null; sync();
      try { p.prompt(); p.userChoice.then(function (c) { if (c && c.outcome !== 'accepted') deferred = p; sync(); }, sync); } catch (e) { deferred = p; sync(); }
    } else if (ios) help();
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-install]');
    if (t) { e.preventDefault(); run(); }
  });
  window.hyonnieInstall = { can: can, run: run, sync: sync };
})();
