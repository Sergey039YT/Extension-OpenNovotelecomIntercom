
function showView(id) {
  document.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('init-error')?.classList.remove('active');
}

function showError(msg) {
  const el = document.getElementById('init-error');
  if (el) {
    el.textContent = msg;
    el.classList.add('active');
  }
}

let currentAuthMethod = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Проверяем, авторизован ли пользователь
  const saved = await chrome.storage.local.get([
    'isAuthorized',    // Авторизованы ли мы?
    'authMethod',      // Метод авторизации (SMS, Номер договора, ручное указание токена)
    'identifier',      // Имя аккаунта (дабы не подгружать его через запрос каждый раз при открытии окна расширения)
    'tokenType',       // Тип токена (на момент 02.03.2025 всегда вовзращает Bearer)
    'accessToken'      // Токен, через которых выполняются запросы
  ]);

  if (saved.isAuthorized) {
    showAuthorizedView(saved);
  } else {
    showView('auth-select');
  }

  // Обработчики выбора метода
  document.querySelectorAll('.auth-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.classList.contains('token') ? 'token' :
                     btn.classList.contains('sms') ? 'sms-phone' : 'credentials';
      currentAuthMethod = method;
      showView(`form-${method}`);
    });
  });

  // Назад
  document.querySelectorAll('.back').forEach(btn => {
    btn.addEventListener('click', () => showView('auth-select'));
  });

  // Отправка форм
  document.getElementById('submit-token').addEventListener('click', () => submitAuth('token'));

  document.getElementById('submit-sms-request').addEventListener('click', getSubscriberIDs);
  document.getElementById('submit-select-subscribers').addEventListener('click', requestSmsCode);
  document.getElementById('submit-sms-code').addEventListener('click', submitSmsCode);
  document.getElementById('back-to-phone').addEventListener('click', () => showView('form-sms-phone'));
  document.getElementById('back-to-subscribers').addEventListener('click', () => showView('form-select-subscribers'));

  document.getElementById('submit-credentials').addEventListener('click', () => submitAuth('credentials'));

  // Авторизованные действия
  document.getElementById('logout').addEventListener('click', logout);
  document.getElementById('show-profile').addEventListener('click', loadProfile);
});


let listSubscriberIDs = [];
async function getSubscriberIDs() {
  const phone = document.getElementById('phone-input').value.trim();
  if (!phone) return showError('Введите номер телефона');

  try {
    const res = await sendMessageToSW({ action: 'getSubscriberIDs', phone });
    if (res.success) {
      // Очищаем старые данные
      const input_list = document.getElementById('input-list');
      input_list.innerHTML = '';

      listSubscriberIDs = res.accounts;

      // Создаём список с информацией о аккаунтах (подписках на адреса)
      res.accounts.forEach(subID => {
        input_list.innerHTML += `<input type="radio" name="subID" value="${subID.subscriberId}">${subID.address}`
      });
      showView('form-select-subscribers');
    } else {
      showError(res.error || 'Не удалось получить информацию о аккаунтах');
    }
  } catch (err) {
    showError('Ошибка: ' + err.message);
  }
}

let selectSubscriberID;
async function requestSmsCode() {
  const phone = document.getElementById('phone-input').value.trim();
  const radios = document.querySelectorAll('input[name="subID"]');

  // Получаем выбранный аккаунт (подписку на адрес)
  let selectedValue;
  radios.forEach(radio => {
    if (radio.checked) selectedValue = radio.value;
  });
  if (!selectedValue) return showError('Выберите один из вариантов');

  // Получаем объект по ID из этого же объекта
  for (const subID of listSubscriberIDs) {
    if (subID.subscriberId == selectedValue) {
      selectSubscriberID = subID;
      break;
    }
  }
  if (!selectSubscriberID) return showError('Выберите один из вариантов');

  try {
    const res = await sendMessageToSW({ action: 'requestSms', selectSubscriberID, phone });
    if (res.success) {
      document.getElementById('sms-phone-display').textContent = phone;
      showView('form-sms-code');
      document.getElementById('sms-code-input').value = '';
    } else {
      showError(res.error || 'Не удалось отправить SMS');
    }
  } catch (err) {
    showError('Ошибка: ' + err.message);
  }
}

async function submitSmsCode() {
  const phone = document.getElementById('phone-input').value.trim();
  const code = document.getElementById('sms-code-input').value.trim();
  if (!code) return showError('Введите SMS-код');

  try {
    const res = await sendMessageToSW({
      action: 'login',
      method: 'sms',
      phone: phone,
      code: code,
      selectSubID: selectSubscriberID,
    });
    if (res.success) {
      const saveData = {
        isAuthorized: true,
        authMethod: 'sms',
        identifier: res.identifier,
        tokenType: res.tokenType,
        accessToken: res.accessToken,
      };
      await chrome.storage.local.set(saveData);
      showAuthorizedView(saveData);
    } else {
      showError(res.error || 'Неверный код');
    }
  } catch (err) {
    showError('Ошибка авторизации: ' + err.message);
  }
}

async function submitAuth(method) {
  let payload = { action: 'login', method };

  if (method === 'token') {
    const token = document.getElementById('token-input').value.trim();
    if (!token) return showError('Введите токен');
    payload.token = token;
  } else if (method === 'credentials') {
    const contract = document.getElementById('contract-input').value.trim();
    const password = document.getElementById('password-input').value;
    if (!contract || !password) return showError('Заполните все поля');
    payload.contract = contract;
    payload.password = password;
  }

  try {
    const res = await sendMessageToSW(payload);
    if (res.success) {
      const saveData = {
        isAuthorized: true,
        authMethod: method,
        identifier: res.identifier,
        tokenType: res.tokenType,
        accessToken: res.accessToken,
      };
      await chrome.storage.local.set(saveData);
      showAuthorizedView(saveData);
    } else {
      showError(res.error || 'Ошибка авторизации');
    }
  } catch (err) {
    showError('Ошибка связи с фоном: ' + err.message);
  }
}

function getMethodLabel(method) {
  return {
    token: 'токену',
    sms: 'SMS (по телефону)',
    credentials: 'договору и паролю'
  }[method] || method;
}

function showAuthorizedView(data) {
  document.getElementById('user-identifier').textContent = data.identifier;
  document.getElementById('auth-method-label').textContent = `Способ входа: по ${getMethodLabel(data.authMethod)}`;

  showView('authorized-view');
}

async function loadProfile() {
  try {
    const res = await sendMessageToSW({ action: 'getProfile' });
    if (res.success && res.profile) {
      document.getElementById('profile-data').textContent = res.profile; // JSON.stringify(res.profile, null, 2)
      document.getElementById('profile-details').classList.add('active');
    } else {
      document.getElementById('profile-data').textContent = 'Нет данных';
    }
    document.getElementById('show-profile').style.display = 'none';
  } catch (err) {
    document.getElementById('profile-data').textContent = 'Ошибка загрузки: ' + err.message;
  }
}

async function logout() {
  try {
    await sendMessageToSW({ action: 'logout' });
    await chrome.storage.local.clear();
    showView('auth-select');
  } catch (err) {
    showError('Ошибка при выходе');
  }
}

// Универсальная функция для однократного общения с service worker
function sendMessageToSW(message) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: message.action });

    const onMessage = (response) => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
      resolve(response);
    };

    const onDisconnect = () => {
      port.onDisconnect.removeListener(onDisconnect);
      reject(new Error('Соединение закрыто'));
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage(message);
  });
}