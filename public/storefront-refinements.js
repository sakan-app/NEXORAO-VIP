'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const aboutMarkup = `
    <div class="overlay" id="aboutOverlay" role="dialog" aria-modal="true" aria-labelledby="aboutHeading">
      <div class="luxury-modal">
        <button class="close" data-close="aboutOverlay" aria-label="Schließen">×</button>
        <div class="luxury-crown" aria-label="Krone">♛</div>
        <h2 id="aboutHeading">Digital Future Stores Group</h2>
        <p class="luxury-subtitle">Eleganz, der Sie vertrauen können</p>
        <div class="ornament">✦</div>
        <div class="about-copy">
          <p>In einer Welt, in der sich Mode immer schneller wandelt, sind wir bei Digital Future überzeugt: Online-Shopping soll ein außergewöhnliches Erlebnis sein – sicher, transparent und von echter Eleganz geprägt.</p>
          <p>Als Gruppe spezialisierter Online-Shops vereinen wir unter einem digitalen Dach eine vielfältige Welt aus Mode, Beauty und allem, was einen modernen Lebensstil bereichert. Wir bieten nicht nur aktuelle Kollektionen, sondern ein durchdachtes Einkaufserlebnis, das auf Transparenz und Verlässlichkeit beruht.</p>
          <div class="ornament" style="text-align:center">⚖</div>
          <h3>Europäische und deutsche Standards</h3>
          <p>Vertrauen ist die Grundlage jeder guten Kundenbeziehung. Deshalb arbeiten alle unsere Shops nach geltendem europäischem und deutschem Recht: konsequenter Datenschutz, transparente Zahlungs- und Rückgabeprozesse und umfassender Verbraucherschutz – für ein sorgenfreies Einkaufserlebnis.</p>
          <div class="ornament" style="text-align:center">✧</div>
          <h3>Für eine nachhaltige digitale Zukunft</h3>
          <p>Wir verkaufen nicht nur Produkte – wir gestalten eine smarte digitale Zukunft, die Ihren Erwartungen entspricht. Unser Ziel: Ihre erste Adresse zu sein, wenn Qualität, schönes Design und ausgezeichneter Service zusammenkommen sollen.</p>
          <p style="text-align:center;color:var(--champagne);font-family:var(--serif)">Digital Future – wir gestalten Ihre Zukunft aus Eleganz und Vertrauen.</p>
          <p style="text-align:center;color:var(--champagne);font-family:var(--serif)">Digital Future Stores Group</p>
        </div>
      </div>
    </div>
    <div class="overlay" id="accountOverlay" role="dialog" aria-modal="true" aria-labelledby="accountHeading">
      <div class="modal account-modal">
        <div class="modal-head"><h2 id="accountHeading">Mein Konto</h2><button class="close" data-close="accountOverlay" aria-label="Schließen">×</button></div>
        <div class="modal-body">
          <div id="accountSignedIn" class="account-signed-in" hidden><p>Angemeldet als <strong id="accountEmail"></strong></p><button class="btn outline" id="accountLogout" type="button">Abmelden</button></div>
          <div id="accountForms">
            <div class="account-tabs" role="tablist" aria-label="Kontooptionen"><button type="button" id="loginTab" aria-selected="true">Anmelden</button><button type="button" id="registerTab" aria-selected="false">Registrieren</button></div>
            <form id="loginForm" class="account-form">
              <div class="field"><label for="loginEmail">E-Mail-Adresse</label><input id="loginEmail" type="email" autocomplete="email" required maxlength="254"></div>
              <div class="field"><label for="loginPassword">Passwort</label><input id="loginPassword" type="password" autocomplete="current-password" required maxlength="128"></div>
              <button class="btn" type="submit">Sicher anmelden</button>
              <button class="btn outline" id="resendVerification" type="button">Bestätigungs-E-Mail erneut senden</button>
            </form>
            <form id="registerForm" class="account-form" hidden>
              <div class="field"><label for="registerEmail">E-Mail-Adresse</label><input id="registerEmail" type="email" autocomplete="email" required maxlength="254"></div>
              <div class="field"><label for="registerPassword">Passwort (mindestens 12 Zeichen)</label><input id="registerPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></div>
              <button class="btn" type="submit">Konto erstellen</button>
              <p class="account-help">Sie erhalten einen Bestätigungslink per E-Mail. Erst nach der Bestätigung ist die Anmeldung möglich.</p>
            </form>
          </div>
          <p class="account-message" id="accountMessage" role="status" aria-live="polite"></p>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', aboutMarkup);

  const headActions = $('.head-actions');
  const cartButton = $('#cartBtn');
  if (cartButton) {
    cartButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.1 11.1a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 1.9-1.4L22 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg><span class="cart-label">Warenkorb</span><span class="count" id="cartCount">0</span>';
    cartButton.setAttribute('aria-label', 'Warenkorb öffnen');
  }
  if (headActions && !$('#accountBtn')) {
    const account = document.createElement('button');
    account.type = 'button'; account.id = 'accountBtn'; account.className = 'icon-btn account-action';
    account.setAttribute('aria-label', 'Anmelden oder Konto erstellen');
    account.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg><span class="account-label">Konto</span>';
    headActions.append(account);
  }

  const imprint = '<h3>Angaben gemäß § 5 DDG</h3><p><strong>Inhaber / Betreiber:</strong> Ahmed Ismail Saed<br><strong>Anschrift:</strong> Ehndorfer Str. 130, 24537 Neumünster, Deutschland</p><h3>Kontakt</h3><p><strong>E-Mail:</strong> <a href="mailto:contact@digital-future.ai">contact@digital-future.ai</a><br><strong>E-Mail:</strong> <a href="mailto:info@digital-future.ai">info@digital-future.ai</a><br><strong>E-Mail:</strong> <a href="mailto:server@digital-future.ai">server@digital-future.ai</a></p><h3>E-Mail-Clients Einrichtung</h3><p><strong>IMAP:</strong> imaps.udag.de – Port 993 SSL/TLS oder 143 STARTTLS<br><strong>POP3:</strong> pops.udag.de – Port 995 SSL/TLS oder 110 STARTTLS<br><strong>SMTP:</strong> smtps.udag.de – Port 465 SSL/TLS oder 587 STARTTLS</p><h3>Verantwortlich für den Inhalt</h3><p>Ahmed Ismail Saed<br>Ehndorfer Str. 130, 24537 Neumünster, Deutschland</p>';
  if (typeof translations !== 'undefined') {
    if (translations.de) translations.de.imprintBody = imprint;
    if (translations.en) translations.en.imprintBody = '<h3>Legal notice</h3><p><strong>Operator:</strong> Ahmed Ismail Saed<br><strong>Address:</strong> Ehndorfer Str. 130, 24537 Neumünster, Germany</p><h3>Contact</h3><p>contact@digital-future.ai<br>info@digital-future.ai<br>server@digital-future.ai</p><h3>Mail client setup</h3><p>IMAP imaps.udag.de: 993 SSL/TLS, 143 STARTTLS<br>POP3 pops.udag.de: 995 SSL/TLS, 110 STARTTLS<br>SMTP smtps.udag.de: 465 SSL/TLS, 587 STARTTLS</p>';
    if (translations.de) translations.de.privacyBody = translations.de.privacyBody.replace(/[A-Z0-9._%+-]+@nexoraonline\.de/gi, 'contact@digital-future.ai');
    if (translations.en) translations.en.privacyBody = translations.en.privacyBody.replace(/[A-Z0-9._%+-]+@nexoraonline\.de/gi, 'contact@digital-future.ai');
  }

  document.addEventListener('click', event => {
    if (event.target.closest('[data-about-open], .nav a[href="#about"]')) {
      event.preventDefault();
      openOverlay('aboutOverlay');
    }
  });
  const showMessage = (message, error = false) => {
    const target = $('#accountMessage');
    target.textContent = message;
    target.classList.toggle('error', error);
  };
  const refreshAccount = async () => {
    try {
      const data = await window.nexoraApi.request('/api/auth/me');
      $('#accountForms').hidden = Boolean(data.user);
      $('#accountSignedIn').hidden = !data.user;
      if (data.user) $('#accountEmail').textContent = data.user.email;
    } catch { /* Keep the sign-in form available when the API is offline. */ }
  };
  const mode = register => {
    $('#loginForm').hidden = register;
    $('#registerForm').hidden = !register;
    $('#loginTab').setAttribute('aria-selected', String(!register));
    $('#registerTab').setAttribute('aria-selected', String(register));
    showMessage('');
  };
  $('#accountBtn').addEventListener('click', () => { refreshAccount(); showMessage(''); openOverlay('accountOverlay'); });
  $('#loginTab').addEventListener('click', () => mode(false));
  $('#registerTab').addEventListener('click', () => mode(true));
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await window.nexoraApi.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value }) });
      $('#accountForms').hidden = true; $('#accountSignedIn').hidden = false; $('#accountEmail').textContent = data.user.email;
      showMessage('Sie sind sicher angemeldet.');
    } catch (error) { showMessage(error.message, true); }
  });
  $('#registerForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await window.nexoraApi.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: $('#registerEmail').value, password: $('#registerPassword').value }) });
      showMessage(data.message + ' Bitte prüfen Sie auch Ihren Spam-Ordner.');
      $('#registerForm').reset();
    } catch (error) { showMessage(error.message, true); }
  });
  $('#resendVerification').addEventListener('click', async () => {
    const email = $('#loginEmail').value.trim();
    if (!email) return showMessage('Bitte geben Sie zuerst Ihre E-Mail-Adresse ein.', true);
    try {
      const data = await window.nexoraApi.request('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      showMessage(data.message);
    } catch (error) { showMessage(error.message, true); }
  });
  $('#accountLogout').addEventListener('click', async () => {
    try { await window.nexoraApi.request('/api/auth/logout', { method: 'POST' }); await refreshAccount(); showMessage('Sie wurden abgemeldet.'); }
    catch (error) { showMessage(error.message, true); }
  });
  const status = new URLSearchParams(location.search).get('account');
  if (status) {
    openOverlay('accountOverlay');
    showMessage(status === 'verified' ? 'Ihre E-Mail-Adresse wurde bestätigt. Sie können sich jetzt anmelden.' : status === 'verification-expired' ? 'Der Bestätigungslink ist abgelaufen. Fordern Sie einen neuen Link an.' : 'Der Bestätigungslink ist ungültig.', status !== 'verified');
    history.replaceState({}, '', location.pathname + location.hash);
  }
  refreshAccount();
})();
