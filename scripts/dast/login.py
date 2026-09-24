"""Вход демонстрационной учётной записью и печать сессионной cookie.

Запускается внутри образа ZAP, в сети стека сканирования: проходит тот же путь,
что браузер, — POST /login, форма каталога, возврат на /login/callback — и
печатает в stdout строку `lct_session=<значение>` для заголовка Cookie.
Только стандартная библиотека: в образе сканера ставить нечего.

Переменные окружения: DAST_TARGET (адрес приложения), DAST_USER, DAST_PASSWORD.
"""

import html
import http.cookiejar
import os
import re
import sys
import urllib.parse
import urllib.request

SESSION_COOKIE = 'lct_session'


def fail(message: str) -> None:
    print(f'login: {message}', file=sys.stderr)
    sys.exit(1)


def main() -> None:
    target = os.environ['DAST_TARGET'].rstrip('/')
    user = os.environ['DAST_USER']
    password = os.environ['DAST_PASSWORD']

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar)
    )

    # Начало входа — POST, и хук csrf приложения сверяет его происхождение.
    # Accept с text/html — как у формы браузера: без него SvelteKit отвечает на
    # действие формы JSON-описанием перенаправления, а не самим перенаправлением.
    start = urllib.request.Request(
        f'{target}/login',
        data=b'',
        method='POST',
        headers={
            'Origin': target,
            'Accept': 'text/html',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    )
    with opener.open(start, timeout=30) as response:
        login_page = response.read().decode('utf-8', 'replace')
        login_url = response.geturl()

    form = re.search(r'<form[^>]*id="kc-form-login"[^>]*>', login_page)
    if form is None:
        fail(f'на {login_url} нет формы входа каталога')
    action = re.search(r'action="([^"]+)"', form.group(0))
    if action is None:
        fail('у формы входа каталога нет адреса отправки')

    credentials = urllib.parse.urlencode(
        {'username': user, 'password': password, 'credentialId': ''}
    ).encode()
    submit = urllib.request.Request(
        html.unescape(action.group(1)),
        data=credentials,
        method='POST',
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    with opener.open(submit, timeout=30) as response:
        final_url = response.geturl()

    session = next((c.value for c in jar if c.name == SESSION_COOKIE), None)
    if session is None:
        fail(f'вход не открыл сессию, остановился на {final_url}')

    print(f'{SESSION_COOKIE}={session}')


if __name__ == '__main__':
    main()
