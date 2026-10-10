checkInterval = setInterval(async function(){var url=document.URL;
	// Добавить кнопку, только если мы авторизованы
 	const saved = await chrome.storage.local.get(['isAuthorized']);
 	if (!saved.isAuthorized) return;

	// Как только панель зума найдена - добавить кнопку и перестать её искать
	if (url.includes('/account/camera/') && document.querySelector("div.opendoor")==null && document.querySelector("div.interactive")!=null){
		var interac=await document.querySelector("div.interactive");

		// Создаём кнопку открытия
		var opendoor=document.createElement('div');
		opendoor.className='opendoor zoom';
		opendoor.innerHTML='<div class="in" style="top: 25%;position: absolute;border-radius: .5em;height: 3em;align-content: center;"><i style="font-style:normal;" class="icon-zoom-in">🔒</i></div></div>';

		interac.append(opendoor);

		var buttonOpen = document.querySelector(".opendoor .in");
		buttonOpen.addEventListener("click", function() {
			// При нажатии, добавить эффект тусклости (яркость на x0.5), если его ещё нет
			if (buttonOpen.style.filter == "brightness(0.5)") return;
			document.querySelector(".opendoor .in").style.cursor = "default";
			buttonOpen.style.filter = "brightness(0.5)";

			// Обработчик ответа от service-worker
			let fetchResponse = (response) => {
				// Возвращаем прежний вид кнопки
				document.querySelector(".opendoor .in").style.cursor = "pointer";
				buttonOpen.style.filter = "brightness(1)";

				// Если запрос отправлен...
				if (response.success) {
					json = JSON.parse(response.text);
					console.log(response.text);

					// Вывести ответ. И если сервер сообщает о открытии двери, то на 4 секунды поменять иконку и цвет кнопки
					if (json['data']['status']) {
						document.querySelector(".opendoor i").innerText = "🔓";
						buttonOpen.style.background = 'lime';
						setTimeout(function(){document.querySelector(".opendoor i").innerText = "🔒";buttonOpen.style.background = '';}, 4000);
					}
				} else {
					alert('ERROR', response.error);
				}
			}

			// Получить ID камеры
			camID = document.querySelector("div.player__event > p > a").href;
			camID = camID.split('CameraID=').pop();

			// Подключаемся к service-worker, привязываем обработчик ответа и отправляем запрос
			const port = chrome.runtime.connect({name: "openDoor"});
			port.onMessage.addListener(fetchResponse);
			port.postMessage({ camID });
		});
		// Завершить цикл
		clearInterval(checkInterval);
		return;
	}
},1000);
