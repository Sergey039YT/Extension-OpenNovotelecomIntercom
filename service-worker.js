
async function generate_auth_hashes(login, password, date, secret = "789sdgHJs678wertv34712376") {
	const pad = (n) => String(n).padStart(2, '0');

	// "ГодМесяцДеньЧасМинутаСекунда", например 20240130130502
	const dateStr = String(date.getFullYear()) +
		pad(date.getMonth() + 1) +
		pad(date.getDate()) +
		pad(date.getHours()) +
		pad(date.getMinutes()) +
		pad(date.getSeconds());

	const tmp = `DigitalHomeNTKpassword${login}${password}${dateStr}${secret}`;

	// SHA1(password) -> base64
	const sha1Buf = await crypto.subtle.digest(
		'SHA-1',
		new TextEncoder().encode(password)
	);
	const sha1Bytes = new Uint8Array(sha1Buf);
	let bin = '';
	for (let i = 0; i < sha1Bytes.length; i++) bin += String.fromCharCode(sha1Bytes[i]);
	const sha1Base64 = btoa(bin);

	// MD5(tmp) -> hex
	const md5Hex = md5(tmp);

	return [sha1Base64, md5Hex];
}

chrome.runtime.onConnect.addListener(function(port) {
	port.onMessage.addListener(async (request) => {
		var response = {success: true};
		var saved = await chrome.storage.local.get(['cameras', 'isAuthorized', 'tokenType', 'accessToken']);
		if (port.name === "openDoor") {
			var camID = request.camID;

			if (!saved.isAuthorized) {
				response.success = false;
				response.error = 'Вы не авторизованы в расширении!';
				port.postMessage(response);
				return;
			}

			// Проверить, есть ли данные о камере в памяти
			var cams = saved.cameras;
			if (!cams) cams = {};
			if (!cams[camID]) {
				// Получить список подписок на адреса (к которым у пользователя есть доступ) (Версия "Умный дом" 8.23.0)
				var resp = await fetch('https://myhome.proptech.ru/rest/v3/subscriber-places', {
					method: "GET",
					headers: {
						'Authorization': `${saved.tokenType} ${saved.accessToken}`,
						'Content-Type': 'application/json; charset=UTF-8'
					}
				});
				const respText = await resp.text();
				try {
					const addresses = JSON.parse(respText).data;
				} catch {
					response.success = false;
					response.error = respText;
					port.postMessage(response);
					return;
				}

				// if (!addresses) return;

				for (let addr of addresses) {
					addr = addr.place.id;
					// Если адрес уже есть в памяти - идём к следующему
					var addrES = [];
					Object.keys(cams).forEach(cam => addrES.push(cams[cam][0]));
					if (addrES.includes(addr)) return;

					// Получить данные об устройствах по ID адреса (Версия "Умный дом" 8.23.0)
					resp = await fetch(`https://myhome.proptech.ru/rest/v1/places/${addr}/accesscontrols`, {
						method: "GET",
						headers: {
							'Authorization': `${saved.tokenType} ${saved.accessToken}`,
							'Content-Type': 'application/json; charset=UTF-8'
						}
					});
					const data = (await resp.json()).data
					data.forEach(device => {
						device.entrances.forEach(entra => {
							// Формат: ID адреса, ID домофона, ID подъезда
							if (entra['id']) cams[entra['externalCameraId']] = [addr, device.id, entra.id];
						})
					})
				}

				await chrome.storage.local.set({cameras: cams});
			}

			if (!cams[camID]) {
				response.success = false;
				response.error = 'Данные об устройстве камеры не найдено! (Возможно, нет доступа)';
				port.postMessage(response);
				return;
			}

			// Открываем дверь и отправляем ответ о результате запроса
			const respFetch = await fetch(`https://myhome.proptech.ru/rest/v1/places/${cams[camID][0]}/accesscontrols/${cams[camID][1]}/entrances/${cams[camID][2]}/actions`, {
				method: "POST",
				headers: {
					'Authorization': `${saved.tokenType} ${saved.accessToken}`,
					'Content-Type': 'application/json; charset=UTF-8'
				},
				body: JSON.stringify({'name':'accessControlOpen'})
			});
			response.success = respFetch.ok;
			if (respFetch.ok) {
				response.text = await respFetch.text();
			}
			port.postMessage(response);

		} else if (port.name === "login") {
			// Если токен указан вручную - записать в память
			if (request.method === "token") {
				await chrome.storage.local.set({
					isAuthorized: true,
					accessToken: request.token,
					tokenType: 'Bearer'
				});

				response.tokenType = 'Bearer';
				response.identifier = '';
				response.accessToken = request.token;

			// Авторизация по номеру договора
			} else if (request.method === "credentials") {
				const contract = request.contract;
				const password = request.password;
				const date = new Date();

				const [h1, h2] = await generate_auth_hashes(contract, password, date);

				const respFetch = await fetch(`https://myhome.proptech.ru/auth/v2/auth/${contract}/password`, {
					method: "POST",
					headers: {
						'Content-Type': 'application/json; charset=UTF-8'
					},
					// Спец. строка - "DigitalHomeNTKpassword{login}{password}{date}{secret}"
					body: JSON.stringify({
						hash1: h1,                        // Хеш (sha1 + base64) спец. строки
						hash2: h2,                        // Хеш (md5) спец. строки
						login: contract,                  // Номер договора
						timestamp: date.toISOString()     // Текущее время
					})
				});

				if (!respFetch.ok) {
					response.success = false;
					response.error = await respFetch.text();
				} else {
					const respJson = await respFetch.json();
					response.tokenType = respJson.tokenType;
					response.accessToken = respJson.accessToken;
					await chrome.storage.local.set({
						isAuthorized: true,
						accessToken: request.token,
						tokenType: 'Bearer'
					});
				}

				response.identifier = '';

			// Авторизация по SMS
			} else if (request.method === "sms") {
				const selectSubID = request.selectSubID;
				const phone = request.phone;
				const code = request.code

				const respFetch = await fetch(`https://myhome.proptech.ru/auth/v2/auth/${phone}/confirmation`, {
					method: "POST",
					headers: {
						'Content-Type': 'application/json; charset=UTF-8'
					},
					body: JSON.stringify({
						'confirm1': code,
						'subscriberId': selectSubID.subscriberId,
						'login': phone,
						'operatorId': selectSubID.operatorId,
						'accountId': selectSubID.accountId,
						'profileId': selectSubID.profileId ? null : selectSubID.toString()
					})
				});
				if (!respFetch.ok) {
					response.success = false;
					response.error = await respFetch.text();
					return;
				}
				const respJson = await respFetch.json();

				response.tokenType = respJson.tokenType;
				response.identifier = '';
				response.accessToken = respJson.accessToken;
			}

			port.postMessage(response);
		} else if (port.name === "requestSms") {
			const account = request.selectSubscriberID;
			const phone = request.phone;

			const respFetch = await fetch(`https://myhome.proptech.ru/auth/v2/confirmation/${phone}`, {
				method: "POST",
				headers: {
					'Content-Type': 'application/json; charset=UTF-8'
				},
				body: JSON.stringify(account)
			})
			if (respFetch.status == 429) {
				response.success = false;
				response.error = 'Слишком много попыток!';
			} else if (!respFetch.ok) {
				response.success = false;
				response.error = await respFetch.text();
			}

			port.postMessage(response);
		} else if (port.name === "getSubscriberIDs") {
			// Получаем список привязанных мест ("аккаунтов")
			const phone = request.phone;
			const respFetch = await fetch(`https://myhome.proptech.ru/auth/v2/login/${phone}`, {
				method: "GET",
				headers: {
					'Content-Type': 'application/json; charset=UTF-8'
				}
			});
			response.accounts = await respFetch.json();
			port.postMessage(response);
		} else if (port.name === "getProfile") {
			const respFetch = await fetch('https://myhome.proptech.ru/rest/v1/subscribers/profiles', {
				method: 'GET',
				headers: {
					'Authorization': `${saved.tokenType} ${saved.accessToken}`,
					'Content-Type': 'application/json; charset=UTF-8'
				}
			});
			const respJson = (await respFetch.json()).data;

			let name = respJson.subscriber.name;
			response.profile = `Номер договора: ${respJson.subscriber.accountId}`;
			if (respJson.subscriber?.id) {
				response.profile += `\nID подписки на адрес: ${respJson.subscriber.id}`;
			}
			response.profile += `\nИмя: ${name}`;
			if (respJson.subscriber.nickName) {
				await chrome.storage.local.set({identifier: respJson.subscriber.nickName})
				response.profile += `\nНик: ${respJson.subscriber.nickName}`;
			} else if (name.lastIndexOf(' ') != -1) {
				await chrome.storage.local.set({identifier: name.trim().slice(0, name.lastIndexOf(' '))})
			}
			if (respJson.subscriberPhones.length > 0) {
				response.profile += `\nНомер телефона: ${respJson.subscriberPhones[0].number}`;
			}
			// response.profile = respJson;

			port.postMessage(response)
		} else if (port.name === "logout") {
			// К сожалению, Электронный город на момент 10.10.2026 не реализовали функцию выхода из аккаунта
			// (для удаления токена. Да что уж, у них даже refreshToken нету. Да даже времени жизни токена...)
			// Хотя в версии "Мой дом" 6.5.0 на момент 02.01.2025 эта функция была, но 13.02.2026 поддержка старой
			// версии приложения была остановлена, а с ней и домен myhome.novotelecom.ru и соотвественно выход из аккаунта
			port.postMessage(response)
		}
	});
});









// ==== MD5 (hex) — реализация blueimp/Joseph Myers, работает в service-worker ====
function md5(s) {
  function safeAdd(x, y) {
	const lsw = (x & 0xffff) + (y & 0xffff);
	const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
	return (msw << 16) | (lsw & 0xffff);
  }
  function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  function binlMD5(x, len) {
	x[len >> 5] |= 0x80 << (len % 32);
	x[(((len + 64) >>> 9) << 4) + 14] = len;

	let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;

	for (let i = 0; i < x.length; i += 16) {
	  const olda = a, oldb = b, oldc = c, oldd = d;

	  a = ff(a, b, c, d, x[i],	  7,  -680876936);
	  d = ff(d, a, b, c, x[i + 1], 12,  -389564586);
	  c = ff(c, d, a, b, x[i + 2], 17,   606105819);
	  b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
	  a = ff(a, b, c, d, x[i + 4],  7,  -176418897);
	  d = ff(d, a, b, c, x[i + 5], 12,  1200080426);
	  c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
	  b = ff(b, c, d, a, x[i + 7], 22,   -45705983);
	  a = ff(a, b, c, d, x[i + 8],  7,  1770035416);
	  d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
	  c = ff(c, d, a, b, x[i + 10],17,	  -42063);
	  b = ff(b, c, d, a, x[i + 11],22, -1990404162);
	  a = ff(a, b, c, d, x[i + 12], 7,  1804603682);
	  d = ff(d, a, b, c, x[i + 13],12,	-40341101);
	  c = ff(c, d, a, b, x[i + 14],17, -1502002290);
	  b = ff(b, c, d, a, x[i + 15],22,  1236535329);

	  a = gg(a, b, c, d, x[i + 1],  5,  -165796510);
	  d = gg(d, a, b, c, x[i + 6],  9, -1069501632);
	  c = gg(c, d, a, b, x[i + 11],14,   643717713);
	  b = gg(b, c, d, a, x[i],	 20,  -373897302);
	  a = gg(a, b, c, d, x[i + 5],  5,  -701558691);
	  d = gg(d, a, b, c, x[i + 10], 9,	38016083);
	  c = gg(c, d, a, b, x[i + 15],14,  -660478335);
	  b = gg(b, c, d, a, x[i + 4], 20,  -405537848);
	  a = gg(a, b, c, d, x[i + 9],  5,   568446438);
	  d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
	  c = gg(c, d, a, b, x[i + 3], 14,  -187363961);
	  b = gg(b, c, d, a, x[i + 8], 20,  1163531501);
	  a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
	  d = gg(d, a, b, c, x[i + 2],  9,   -51403784);
	  c = gg(c, d, a, b, x[i + 7], 14,  1735328473);
	  b = gg(b, c, d, a, x[i + 12],20, -1926607734);

	  a = hh(a, b, c, d, x[i + 5],  4,	 -378558);
	  d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
	  c = hh(c, d, a, b, x[i + 11],16,  1839030562);
	  b = hh(b, c, d, a, x[i + 14],23,	-35309556);
	  a = hh(a, b, c, d, x[i + 1],  4, -1530992060);
	  d = hh(d, a, b, c, x[i + 4], 11,  1272893353);
	  c = hh(c, d, a, b, x[i + 7], 16,   -155497632);
	  b = hh(b, c, d, a, x[i + 10],23, -1094730640);
	  a = hh(a, b, c, d, x[i + 13], 4,   681279174);
	  d = hh(d, a, b, c, x[i],	 11,   -358537222);
	  c = hh(c, d, a, b, x[i + 3], 16,   -722521979);
	  b = hh(b, c, d, a, x[i + 6], 23,	 76029189);
	  a = hh(a, b, c, d, x[i + 9],  4,   -640364487);
	  d = hh(d, a, b, c, x[i + 12],11,   -421815835);
	  c = hh(c, d, a, b, x[i + 15],16,	530742520);
	  b = hh(b, c, d, a, x[i + 2], 23,   -995338651);

	  a = ii(a, b, c, d, x[i],	  6,  -198630844);
	  d = ii(d, a, b, c, x[i + 7], 10,  1126891415);
	  c = ii(c, d, a, b, x[i + 14],15, -1416354905);
	  b = ii(b, c, d, a, x[i + 5], 21,	-57434055);
	  a = ii(a, b, c, d, x[i + 12], 6,  1700485571);
	  d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
	  c = ii(c, d, a, b, x[i + 10],15,	 -1051523);
	  b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
	  a = ii(a, b, c, d, x[i + 8],  6,  1873313359);
	  d = ii(d, a, b, c, x[i + 15],10,	-30611744);
	  c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
	  b = ii(b, c, d, a, x[i + 13],21,  1309151649);
	  a = ii(a, b, c, d, x[i + 4],  6,  -145523070);
	  d = ii(d, a, b, c, x[i + 11],10, -1120210379);
	  c = ii(c, d, a, b, x[i + 2], 15,   718787259);
	  b = ii(b, c, d, a, x[i + 9], 21,  -343485551);

	  a = safeAdd(a, olda);
	  b = safeAdd(b, oldb);
	  c = safeAdd(c, oldc);
	  d = safeAdd(d, oldd);
	}
	return [a, b, c, d];
  }

  function binl2hex(input) {
	const hex = '0123456789abcdef';
	let out = '';
	for (let i = 0; i < input.length * 4; i++) {
	  out += hex.charAt((input[i >> 2] >>> ((i % 4) * 8 + 4)) & 0x0f)
		   + hex.charAt((input[i >> 2] >>> ((i % 4) * 8))	 & 0x0f);
	}
	return out;
  }
  function rstr2binl(input) {
	const output = [];
	output[(input.length >> 2) - 1] = undefined;
	for (let i = 0; i < output.length; i++) output[i] = 0;
	for (let i = 0; i < input.length * 8; i += 8) {
	  output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
	}
	return output;
  }
  // UTF-8 encode строки (аналог .encode('utf-8') в Python)
  const utf8 = unescape(encodeURIComponent(s));
  return binl2hex(binlMD5(rstr2binl(utf8), utf8.length * 8));
}
