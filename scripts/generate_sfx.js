const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const sfxDir = path.join(__dirname, '..', 'assets', 'sfx');
if (!fs.existsSync(sfxDir)) fs.mkdirSync(sfxDir, { recursive: true });

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(-300)));
    });
  });
}

async function generateAll() {
  console.log('[SFX] Generating studio sound effects in', sfxDir);

  // 1. sfx_magic.mp3: Sparkling fairy dust chime (harmonic bell tones decaying)
  const magicPath = path.join(sfxDir, 'sfx_magic.mp3');
  await run([
    '-y', '-f', 'lavfi',
    '-i', 'anoisesrc=d=2.5:c=pink:r=44100:a=0.04',
    '-f', 'lavfi',
    '-i', 'sine=f=1046.5:d=2.5',
    '-f', 'lavfi',
    '-i', 'sine=f=1318.5:d=2.5',
    '-f', 'lavfi',
    '-i', 'sine=f=1567.9:d=2.5',
    '-f', 'lavfi',
    '-i', 'sine=f=2093.0:d=2.5',
    '-filter_complex',
    '[1:a]volume=0.3,afade=t=out:st=0.2:d=2.2[s1];' +
    '[2:a]adelay=120|120,volume=0.25,afade=t=out:st=0.3:d=2.1[s2];' +
    '[3:a]adelay=240|240,volume=0.25,afade=t=out:st=0.4:d=2.0[s3];' +
    '[4:a]adelay=360|360,volume=0.2,afade=t=out:st=0.5:d=1.9[s4];' +
    '[0:a]highpass=f=2000,lowpass=f=8000,afade=t=out:st=0.1:d=2.3[shimmer];' +
    '[s1][s2][s3][s4][shimmer]amix=inputs=5:duration=first[out]',
    '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', magicPath
  ]);
  console.log('✅ Generated sfx_magic.mp3');

  // 2. sfx_cheer.mp3: Happy celebratory major chord fanfare
  const cheerPath = path.join(sfxDir, 'sfx_cheer.mp3');
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'sine=f=523.25:d=2.2',
    '-f', 'lavfi', '-i', 'sine=f=659.25:d=2.2',
    '-f', 'lavfi', '-i', 'sine=f=783.99:d=2.2',
    '-f', 'lavfi', '-i', 'sine=f=1046.5:d=2.2',
    '-filter_complex',
    '[0:a]volume=0.25,afade=t=out:st=0.3:d=1.8[c1];' +
    '[1:a]adelay=100|100,volume=0.25,afade=t=out:st=0.4:d=1.7[c2];' +
    '[2:a]adelay=200|200,volume=0.25,afade=t=out:st=0.5:d=1.6[c3];' +
    '[3:a]adelay=300|300,volume=0.3,afade=t=out:st=0.6:d=1.5[c4];' +
    '[c1][c2][c3][c4]amix=inputs=4:duration=first[out]',
    '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', cheerPath
  ]);
  console.log('✅ Generated sfx_cheer.mp3');

  // 3. sfx_birds.mp3: Cheerful woodland bird twitter / morning ambience
  const birdsPath = path.join(sfxDir, 'sfx_birds.mp3');
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'sine=f=2800:d=2.5',
    '-f', 'lavfi', '-i', 'sine=f=3400:d=2.5',
    '-filter_complex',
    '[0:a]tremolo=f=12:d=0.8,volume=0.18,afade=t=in:st=0:d=0.2,afade=t=out:st=1.8:d=0.6[b1];' +
    '[1:a]adelay=400|400,tremolo=f=15:d=0.7,volume=0.15,afade=t=in:st=0.4:d=0.2,afade=t=out:st=1.9:d=0.5[b2];' +
    '[b1][b2]amix=inputs=2:duration=first[out]',
    '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', birdsPath
  ]);
  console.log('✅ Generated sfx_birds.mp3');

  // 4. sfx_water.mp3: Gentle stream water splash / bubbling brook
  const waterPath = path.join(sfxDir, 'sfx_water.mp3');
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'anoisesrc=d=2.5:c=brown:r=44100:a=0.12',
    '-filter_complex',
    '[0:a]bandpass=f=800:width_type=h:w=600,tremolo=f=6:d=0.6,volume=0.22,afade=t=in:st=0:d=0.3,afade=t=out:st=1.8:d=0.6[out]',
    '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', waterPath
  ]);
  console.log('✅ Generated sfx_water.mp3');

  // 5. sfx_whoosh.mp3: Playful sliding whoosh / bouncy jump
  const whooshPath = path.join(sfxDir, 'sfx_whoosh.mp3');
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'anoisesrc=d=1.5:c=pink:r=44100:a=0.15',
    '-filter_complex',
    '[0:a]bandpass=f=1200:width_type=h:w=900,flanger=speed=2:depth=5,volume=0.25,afade=t=in:st=0:d=0.2,afade=t=out:st=0.6:d=0.8[out]',
    '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', whooshPath
  ]);
  console.log('✅ Generated sfx_whoosh.mp3');

  // 6. sfx_footsteps.mp3: Cute little paw steps / bunny hop rhythm
  const stepsPath = path.join(sfxDir, 'sfx_footsteps.mp3');
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'sine=f=220:d=0.15',
    '-f', 'lavfi', '-i', 'sine=f=280:d=0.15',
    '-f', 'lavfi', '-i', 'sine=f=240:d=0.15',
    '-f', 'lavfi', '-i', 'sine=f=300:d=0.15',
    '-filter_complex',
    '[0:a]volume=0.3,afade=t=out:st=0.03:d=0.1[h1];' +
    '[1:a]adelay=350|350,volume=0.3,afade=t=out:st=0.03:d=0.1[h2];' +
    '[2:a]adelay=700|700,volume=0.3,afade=t=out:st=0.03:d=0.1[h3];' +
    '[3:a]adelay=1050|1050,volume=0.3,afade=t=out:st=0.03:d=0.1[h4];' +
    '[h1][h2][h3][h4]amix=inputs=4:duration=longest[out]',
    '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', stepsPath
  ]);
  console.log('✅ Generated sfx_footsteps.mp3');

  console.log('[SFX] All 6 sound effects successfully generated!');
}

generateAll().catch(e => {
  console.error('[SFX] Error generating:', e);
});

