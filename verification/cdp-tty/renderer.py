"""Actual Linux Kitty/X11 renderer proof, separate from a PTY protocol sink.

Xvfb, clipboard/key mapping, profiles and pages belong only to this fixture.
ASCII travels through XTEST key events; committed Japanese uses Kitty's standard
send_text action triggered by a real key chord (not a CDP input or a fake ACK).
This is not Japanese IME composition, physical keyboard or Windows/SSH proof.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import urllib.request


def prove(root, browser, eventually, record):
    from PIL import Image, ImageChops
    for program in ('Xvfb', 'kitty', 'xdotool', 'scrot'):
        assert shutil.which(program), f'real renderer dependency REQUIRED: {program}'
    with tempfile.TemporaryDirectory(prefix='cdp-tty-renderer-') as home:
        read_fd, write_fd = os.pipe()
        with open(Path(home)/'xvfb.log', 'wb') as server_log:
            server = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0',
                '1280x900x24', '-nolisten', 'tcp'], pass_fds=(write_fd,),
                stdout=server_log, stderr=server_log)
            os.close(write_fd)
            try:
                assert select.select([read_fd], [], [], 8)[0], 'Xvfb readiness not observed'
                number = os.read(read_fd, 64).strip().decode()
                assert number.isdecimal(), number
                env = {**os.environ, 'DISPLAY': ':'+number, 'HOME': home,
                    'XDG_CONFIG_HOME': home+'/config', 'LIBGL_ALWAYS_SOFTWARE': '1'}
                env.pop('WAYLAND_DISPLAY', None)

                def xdo(*args):
                    return subprocess.run(['xdotool', *map(str,args)], env=env, check=True,
                        capture_output=True, text=True, timeout=5).stdout.strip()

                def snapshot(name):
                    path=Path(home)/(name+'.png')
                    subprocess.run(['scrot','--overwrite',str(path)], env=env, check=True,
                        capture_output=True, timeout=5)
                    with Image.open(path) as image:
                        rgb=image.convert('RGB').copy()
                    # No OCR or injected browser screenshot: inspect actual X scanout.
                    count=sum(n for n,pixel in rgb.getcolors(rgb.width*rgb.height)
                        if all(abs(a-b)<=2 for a,b in zip(pixel,(190,210,230))))
                    return count,path,rgb

                with browser() as (page,ctl,chrome,debug,_):
                    ctl.evaluate("document.body.style.background='rgb(190,210,230)';document.querySelector('#text').focus()")
                    before=ctl.evaluate('[innerWidth,innerHeight,devicePixelRatio]')
                    target=page['id']
                    for iteration in range(2):
                        log_path=Path(home)/f'kitty-{iteration}.log'
                        with open(log_path,'wb') as terminal_log:
                            terminal=subprocess.Popen(['kitty','--config','NONE','--title','cdp-tty-A-proof',
                                '-o','linux_display_server=x11','-o','remember_window_size=no',
                                '-o','initial_window_width=1000','-o','initial_window_height=720',
                                '-o','enable_audio_bell=no','-o','font_family=DejaVu Sans Mono',
                                '-o','font_size=12','-o','map ctrl+alt+j send_text all 日本語',
                                str(root/'cdp-tty'),page['webSocketDebuggerUrl']],
                                env=env,stdout=terminal_log,stderr=terminal_log)
                            try:
                                def alive():
                                    assert terminal.poll() is None, log_path.read_text()
                                def visible():
                                    alive()
                                    found=subprocess.run(['xdotool','search','--onlyvisible','--name','^cdp-tty-A-proof$'],
                                        env=env,capture_output=True,text=True,timeout=3)
                                    return found.stdout.strip().splitlines()[0] if found.returncode==0 and found.stdout.strip() else None
                                def page_text(text):
                                    alive()
                                    return ctl.evaluate("document.querySelector('#text').value") == text
                                def changed(previous, name):
                                    alive()
                                    count,path,image=snapshot(name)
                                    return (count,path,image) if count>10000 and ImageChops.difference(previous,image).getbbox() else None

                                window=eventually(visible)
                                xdo('windowfocus','--sync',window)
                                eventually(lambda: snapshot('shown')[0]>10000)
                                if iteration==0:
                                    initial=snapshot('initial')[2]
                                    xdo('type','--clearmodifiers','--delay','5','abc')
                                    eventually(lambda: page_text('abc'))
                                    ascii_image=eventually(lambda: changed(initial,'ascii'))[2]
                                    record('A-real-kitty-XTEST-ASCII',renderer=True,physical_keyboard=False)
                                    xdo('key','--clearmodifiers','ctrl+a')
                                    eventually(lambda: ctl.evaluate("document.querySelector('#text').selectionEnd-document.querySelector('#text').selectionStart")==3)
                                    selected_image=eventually(lambda: changed(ascii_image,'selected'))[2]
                                    # A terminal-native committed string, not an X keymap's
                                    # attempted emulation of a Japanese input method.
                                    xdo('key','--clearmodifiers','ctrl+alt+j')
                                    eventually(lambda: page_text('日本語'))
                                    # DOM input can complete before the new PNG reaches the terminal.
                                    # The evidence must be the *updated* rendered frame, not old 'abc'.
                                    count,path,_=eventually(lambda: changed(selected_image,'real-terminal'))
                                    shutil.copyfile(path,root/'real-terminal.png')
                                    record('A-real-kitty-committed-Japanese',renderer=True,
                                        input_source='Kitty send_text via XTEST key chord',
                                        png_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                                    xdo('windowsize',window,900,660)
                                    eventually(lambda: snapshot('resized')[0]>10000)
                                    assert ctl.evaluate('[innerWidth,innerHeight,devicePixelRatio]')==before
                                    xdo('mousemove','--window',window,400,380,'click',5)
                                    eventually(lambda: ctl.evaluate('scrollY')>0)
                                    eventually(lambda: snapshot('wheel')[0]>10000)
                                    record('A-real-kitty-X11-render-input-resize-wheel',pixels=count,
                                        renderer=True,physical_keyboard=False)
                                xdo('key','--clearmodifiers','ctrl+q')
                                terminal.wait(timeout=8)
                                assert terminal.returncode==0, log_path.read_text()
                            except BaseException:
                                # All data are this fixed fixture, never a user's tab/auth.
                                print(json.dumps({'test':'A-renderer-diagnostic','terminal_exit':terminal.poll(),
                                    'dom':ctl.evaluate("({value:document.querySelector('#text').value,focus:document.activeElement.id,events:events.slice(-12)})"),
                                    'terminal_log':log_path.read_text()[-4000:],
                                    'xvfb_log':(Path(home)/'xvfb.log').read_text()[-2000:]}),flush=True)
                                raise
                            finally:
                                if terminal.poll() is None:
                                    terminal.terminate()
                                    try: terminal.wait(timeout=3)
                                    except subprocess.TimeoutExpired: terminal.kill();terminal.wait(timeout=3)
                        assert chrome.poll() is None
                        pages=json.load(urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/list',timeout=2))
                        assert any(item['id']==target for item in pages)
                        assert ctl.evaluate("document.querySelector('#text').value")=='日本語'
                    record('A-real-kitty-explicit-reattach-same-Chrome',attachments=2,same_target=True)
            finally:
                os.close(read_fd)
                server.terminate()
                try: server.wait(timeout=3)
                except subprocess.TimeoutExpired: server.kill();server.wait(timeout=3)
