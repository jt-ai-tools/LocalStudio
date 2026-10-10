"""Local integration checks for enhancement preparation and CPU blending."""
import asyncio
import json
from pathlib import Path
import subprocess
import aiohttp

BASE = 'http://127.0.0.1:8188'
ROOT = Path(__file__).resolve().parents[1]

async def main():
    fixture = ROOT / 'ComfyUI/input/enhance_audio_test.mp4'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=864x480:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:v','libx264','-c:a','aac','-y',str(fixture)],check=True)
    async with aiohttp.ClientSession() as session:
        with fixture.open('rb') as video:
            form = aiohttp.FormData(); form.add_field('video', video, filename=fixture.name, content_type='video/mp4'); form.add_field('duration','1')
            async with session.post(BASE+'/h3-studio/enhance/prepare',data=form) as response:
                assert response.status == 200, await response.text()
                prepared = await response.json()
        assert prepared['outputWidth'] == 1296 and prepared['outputHeight'] == 720
        assert prepared['sound'] is True
        async with session.post(BASE+'/h3-studio/enhance/blend',json={'sourceId':prepared['sourceId'],'raw':None,'strength':0}) as response:
            assert response.status == 200, await response.text()
            output = await response.json()
        target = ROOT/'ComfyUI/output'/output['subfolder']/output['filename']
        streams=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(target)],text=True))['streams']
        assert any(s['codec_type']=='audio' for s in streams)
        assert next(s for s in streams if s['codec_type']=='video')['r_frame_rate']=='24/1'
        assert fixture.is_file()
        async with session.post(BASE+'/h3-studio/enhance/blend',json={'sourceId':prepared['sourceId'],'raw':None,'strength':101}) as response:
            assert response.status == 400
        async with session.post(BASE+'/h3-studio/enhance/blend',json={'sourceId':'../escape','raw':None,'strength':0}) as response:
            assert response.status == 400
        async with session.post(BASE+'/h3-studio/enhance/prepare',json={'source':{'filename':'../escape.mp4','subfolder':'video'}}) as response:
            assert response.status == 400
        async with session.post(BASE+'/h3-studio/enhance/prepare',json={'source':{'filename':'H3_Studio_00004_.mp4','subfolder':'video'},'start':1000,'duration':3}) as response:
            assert response.status == 400
        async with session.delete(BASE+'/h3-studio/output',json={'filename':output['filename'],'subfolder':output['subfolder']}) as response:
            assert response.status == 200
        fixture.unlink()
        for extension in ('.mp4', '.json'):
            (ROOT/'ComfyUI/input/h3_enhance'/f"{prepared['sourceId']}{extension}").unlink()
        print('PASS: upload, 720p geometry, audio/fps preservation, original retained, strength/path/time validation')

if __name__ == '__main__':
    asyncio.run(main())
