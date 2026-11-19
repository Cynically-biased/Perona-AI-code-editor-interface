function reportPetActivity(kind, target) {
  document.dispatchEvent(new CustomEvent('perona-activity', { detail: { kind, target } }));
}

(() => {
  const pet = document.querySelector('#perona-pet');
  const hit = pet.querySelector('button');
  const canvas = pet.querySelector('canvas');
  const pixels = canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const random = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const colors = {
    k: '#28132e', d: '#512344', r: '#ad4167', p: '#ef82ad', h: '#ffb1ce',
    w: '#fffff1', s: '#ffd8c8', b: '#ef969f', a: '#c4a5eb', g: '#ede2ff',
    v: '#7c4c9c', l: '#f8d489'
  };
  const hat = [
    '.......kkk.......', '......krrrk......', '.....krrrrrk.....',
    '....krrwwwrrk....', '....krwkwkwrk....', '...kddwwwwwddk...',
    '..krrddddddrrk..', '.kppppppppppppk.', 'kkkkkkkkkkkkkkkkk'
  ];
  const face = [
    '....kkkkkkkkk....', '..krrpphppprrk..', '.krphphhpphppprk.',
    'krphphsshpphppprk', 'krphsssssphsppprk', 'kppsssssssssppppk',
    'kppskkksskkkspppk', 'kppskwksskwkspppk',
    'kppskvksskvkspppk', 'kppbbssssssbbpppk',
    '.kppssskbsssppk..', '..kppssssspppk...', '...kkkkkkkkkk....'
  ];
  const dress = [
    '....kkkkkk....', '...kwwddwwk...', '..kddwppwddk..',
    '..kdddpddddk..', '...kddddddk...', '..krrdrrdrrk..',
    '.kddrddddrddk.', 'krrddddddddrrk', 'kwkkkkkkkkkkwk',
    '.kwwwwwwwwwwk.', '..kkkkkkkkkk..'
  ];
  const ghost = [
    '...kkkkkk.....', '..kggggggk....', '.kggggggggk...',
    'kggkggggkggk..', 'kgwkgwwgkwgk..', 'kggggkkggggk..',
    'kggggggggggk.k', '.kggggggggkgk.', '..kggggggggk..',
    '...kkgggggk...', '.....kkkkk....'
  ];
  const reactions = [
    { name: 'surprise', pose: 'gasp', mark: ['.ll.', '.ll.', '.ll.', '....', '.ll.'] },
    { name: 'blush', pose: 'blush', mark: ['.pp.pp.', 'pphpppp', 'ppppppp', '.ppppp.', '..ppp..', '...p...'] },
    { name: 'wink', pose: 'wink', mark: ['...l...', '...l...', '.lllll.', '...l...', '...l...'] },
    { name: 'giggle', pose: 'laugh', mark: ['..ppp', '..p.p', '..p.p', 'ppp..', 'pp...'] },
    { name: 'pout', pose: 'pout', mark: ['.gg..gg.', 'gggggggg', '.gggggg.', '..gggg..'] },
    { name: 'wave', pose: 'wave', mark: ['g...g', '.g.g.', '..g..', '.g.g.', 'g...g'] },
    { name: 'twirl', pose: 'spin', mark: ['..hhhh.', '.h....h', '.h.hhh.', '..h..h.', '...hh..'] },
    { name: 'sleepy', pose: 'sleep', mark: ['aaaaa', '...a.', '..a..', '.a...', 'aaaaa'] },
    { name: 'spook', pose: 'spook', mark: ghost },
    { name: 'bounce', pose: 'jump', mark: ['l...h...l', '.l..h..l.', '....h....', 'l.......l'] }
  ];
  const shakeReactions = {
    dizzy: { pose: 'shake-dizzy', duration: 1450 },
    sick: { pose: 'shake-sick', duration: 1700 }
  };
  const activityReactions = {
    // She ducks under the frame, braces against motion, and keeps an eye on moving panes.
    resize: { face: 'squint', motion: 'duck' },
    move: { face: 'clenched', prop: ['ll....', '..ll..', 'll....'], motion: 'brace' },
    layout: { face: 'sharp', prop: ['a..a', '.aa.', '.aa.', 'a..a'], motion: 'lean' },
    fileMove: { face: 'curious', prop: ['.ll...', 'llllll', 'lwwwwl', 'llllll'], motion: 'carry' },
    // Chat earns a look over her shoulder. Code earns a much closer inspection.
    chat: { face: 'look', prop: ['.wwww.', 'wvvvvw', 'w.vv.w', '.www..', '..w...'], motion: 'peek' },
    edit: { face: 'inspect', prop: ['.aaa..', 'a...a.', 'a...a.', '.aaa..', '....a.', '.....a'], motion: 'inspect' },
    terminal: { face: 'skeptical', prop: ['kkkkkkk', 'kaw...k', 'k.aa..k', 'kawww.k', 'kkkkkkk'], motion: 'recoil' },
    send: { face: 'smirk', prop: ['...wwww', '.wwgww.', 'wwggw..', '...w...'], motion: 'flick' },
    answer: { face: 'pleased', prop: ['.l.l..', 'lllll.', '.lll..', '..l...'], motion: 'nod' },
    scroll: { face: 'dizzy', prop: ['..aa..', '.a..a.', '....a.', '..aa..', '.a....'], motion: 'track' },
    menu: { face: 'skeptical', prop: ['...a.', '..aa.', '.a.a.', '..aa.', '...a.'], motion: 'peek' },
    petMenu: { face: 'sharp', prop: ['.p.p.', '..p..', '.p.p.'], motion: 'lean' },
    command: { face: 'glare', prop: ['rr.rr', '.r.r.', 'r...r', 'rr.rr'], motion: 'stomp' },
    navigation: { face: 'alert', prop: ['..w...', 'wwwvv.', '..w.vv'], motion: 'turn' },
    save: { face: 'pleased', prop: ['a...a', 'a...a', '.a.a.', '..a..'], motion: 'stamp' },
    control: { face: 'curious', prop: ['.hhh.', 'h...h', '...h.', '..h..', '.....', '..h..'], motion: 'nod' }
  };
  let x = 100;
  let y = innerHeight - 26;
  let facing = 1;
  let drag;
  let action;
  let feedback;
  const lastActivity = new Map();
  let lastReaction = -1;
  let previousTime = 0;

  function sprite(rows, left, top) {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        const color = colors[row[dx]];
        if (color) rect(color, left + dx, top + dy, 1, 1);
      }
    });
  }

  function rect(color, left, top, width, height) {
    pixels.fillStyle = color;
    pixels.fillRect(left, top, width, height);
  }

  function activityMotion(motion, time, progress) {
    const pulse = Math.sin(Math.PI * progress);
    switch (motion) {
      case 'duck': return [0, Math.round(pulse * 4), .28];
      case 'brace': return [Math.round(Math.sin(time / 37) * pulse * 3), 1, -.36];
      case 'lean': return [Math.round(pulse * 3), -1, .11];
      case 'carry': return [Math.round(pulse * 2), Math.floor(time / 130) % 2, -.26];
      case 'peek': return [Math.round(pulse * 2), -Math.round(pulse * 2), -.3];
      case 'inspect': return [Math.round(pulse * 3), Math.round(pulse * 2), -.32];
      case 'recoil': return [-Math.round(pulse * 3), 1, .25];
      case 'flick': return [Math.round(pulse * 2), -Math.round(pulse * 3), .36];
      case 'nod': return [0, Math.round(Math.sin(time / 75) * pulse * 2), -.14];
      case 'track': return [0, Math.round(Math.sin(time / 55) * pulse * 2), .02];
      case 'turn': return [Math.round(pulse * 2), -1, -.19];
      case 'stamp': return [0, progress < .45 ? -2 : 2, .12];
      case 'stomp': return [0, progress < .35 ? -3 : 2, -.38];
      default: return [0, 0, -.16];
    }
  }

  function paintActivityFace(face, look, time) {
    for (const eye of [13, 18]) {
      rect(colors.s, eye, 23, 4, 4);
      if (face === 'squint' || face === 'pleased') {
        sprite(['.kk.', 'k..k'], eye, 24);
      } else {
        const pupil = face === 'dizzy' ? Math.floor(time / 90) % 3 - 1 : look;
        rect(colors.v, eye + 1 + pupil, 24, 2, 3);
        rect(colors.w, eye + 1 + pupil, 24, 1, 1);
        if (face === 'glare' || face === 'sharp') sprite(eye === 13 ? ['k...', '.kk.'] : ['...k', '.kk.'], eye, 23);
        if (face === 'skeptical') rect(colors.k, eye, eye === 13 ? 24 : 22, 4, 1);
      }
    }
    const mouths = {
      glare: ['.kk.', 'k..k'], clenched: ['kkkk', 'kwwk'], smirk: ['...k', '.kk.'],
      inspect: ['.kk.'], pleased: ['k..k', '.kk.'], alert: ['.kk.', '.kk.'],
      curious: ['.r..', '.r..'], dizzy: ['.kk.', '.kk.']
    };
    rect(colors.s, 16, 28, 4, 2);
    sprite(mouths[face] ?? ['..k.'], 16, 28);
  }

  function paintActivityProp(kind, prop, progress, time, look) {
    const side = x > innerWidth - 70 || (look < 0 && x > 64) ? 7 : 47;
    let left = side;
    let top = 20;
    if (kind === 'resize') {
      const inset = Math.round(Math.sin(Math.PI * progress) * 4);
      for (const edge of [side + inset, side + 10 - inset]) {
        rect(colors.a, edge, 14, 1, 9);
        rect(colors.w, edge - 1, 14, 3, 1);
        rect(colors.w, edge - 1, 22, 3, 1);
      }
      return;
    }
    if (kind === 'send') {
      left += Math.round(progress * (side === 7 ? -6 : 8));
      top -= Math.round(progress * 13);
    } else if (kind === 'chat' || kind === 'edit') {
      top += Math.floor(time / 140) % 2;
    } else if (kind === 'fileMove' || kind === 'layout' || kind === 'navigation') {
      left += Math.round(Math.sin(Math.PI * progress) * (side === 7 ? -4 : 4));
    } else if (kind === 'move') {
      left -= Math.floor(time / 65) % 3;
    } else if (kind === 'scroll') {
      top += Math.round(Math.sin(time / 70) * 4);
    } else {
      top -= Math.round(progress * 6);
    }
    sprite(prop, left, top);
  }

  function paintShakeReaction(pose, time, duration) {
    if (pose === 'shake-dizzy') {
      for (let i = 0; i < 3; i++) {
        const angle = time / 145 + i * Math.PI * 2 / 3;
        const left = 17 + Math.round(Math.cos(angle) * 13);
        const top = 8 + Math.round(Math.sin(angle) * 3);
        rect(colors.l, left - 1, top, 3, 1);
        rect(colors.w, left, top - 1, 1, 3);
      }
    } else if (pose === 'shake-sick') {
      const green = '#9ccd69';
      const progress = clamp((time - 180) / (duration - 180), 0, 1);
      if (!progress || progress >= .82) return;
      for (let i = 0; i < 5; i++) {
        const step = (time / 640 + i / 6) % 1;
        if (step > .75) continue;
        const left = 17 - Math.round(step * (16 + i));
        const top = 31 + Math.round(step * step * (22 + i));
        rect(green, left, top, i % 2 + 1, 2);
        rect('#d1e78e', left + 1, top, 1, 1);
      }
    }
  }

  function parasol(left, top, tilt) {
    const widths = [4, 10, 16, 20, 24, 26, 28, 28, 28];
    widths.forEach((width, row) => {
      const start = left + Math.round(row * tilt) - Math.floor(width / 2);
      rect(colors.k, start, top + row, width, 1);
      if (row > 0 && row < widths.length - 1) {
        rect(colors.r, start + 1, top + row, width - 2, 1);
        rect(colors.p, start + Math.floor(width / 3), top + row, Math.max(2, Math.floor(width / 3)), 1);
        rect(colors.h, start + Math.floor(width / 2), top + row, 2, 1);
      }
      if (row === widths.length - 1) {
        for (let scallop = 1; scallop < width - 2; scallop += 5) {
          rect(colors.w, start + scallop, top + row, 3, 1);
          rect(colors.r, start + scallop + 1, top + row + 1, 2, 1);
        }
      }
    });
    rect(colors.k, left - 1, top - 2, 2, 2);
    const shaft = left + Math.round(7 * tilt);
    rect(colors.k, shaft, top + 8, 2, 19 - top);
    rect(colors.h, shaft + 1, top + 10, 1, 15 - top);
    rect(colors.k, shaft - 2, 26, 3, 2);
  }

  function paint() {
    const t = action.elapsed;
    const mode = drag ? 'held' : action.kind;
    const expression = action.reaction;
    const activity = !expression && feedback;
    const reactionTime = t;
    const pose = expression?.pose;
    const progress = activity ? activity.elapsed / activity.duration : 0;
    const [lean, crouch, activityTilt] = activity
      ? activityMotion(activity.reaction.motion, activity.elapsed, progress) : [0, 0, null];
    const step = Math.floor(t / 105) % 4;
    const stride = mode === 'walk' ? [0, 2, 0, -2][step] : mode === 'fly' || mode === 'held' ? 1 : 0;
    const bob = mode === 'walk' ? step % 2 : mode === 'fly' || mode === 'held' ? 2
      : Math.round(Math.sin(t / 250) * .6);
    const blink = mode === 'idle' && t % 1650 > 1290 && t % 1650 < 1430;
    const jump = pose === 'jump' || pose === 'gasp' ? Math.round(Math.abs(Math.sin(reactionTime / 120)) * 5) : 0;
    pixels.clearRect(0, 0, canvas.width, canvas.height);
    pixels.save();
    if ((facing < 0) !== (pose === 'spin' && Math.floor(reactionTime / 105) % 4 >= 2)) {
      pixels.translate(canvas.width, 0);
      pixels.scale(-1, 1);
    }
    pixels.translate(15, 0);
    pixels.save();
    const shakeLean = pose === 'shake-dizzy' ? Math.round(Math.sin(t / 75) * 2) : pose === 'shake-sick' ? -2 : 0;
    const shakeBend = pose === 'shake-sick' ? 3 + Math.floor(t / 130) % 2 : 0;
    pixels.translate(lean + shakeLean, -bob - jump + crouch + shakeBend);
    const curl = ['.kkk.', 'kphhk', 'kphhk', 'krphk', 'krppk', '.kppk', '.krpk', 'kppk.', '.kk..'];
    sprite(curl, 5, 24 + step % 2);
    sprite(curl, 26, 24 + (step + 1) % 2);
    rect(colors.w, 7, 24, 2, 1);
    rect(colors.w, 27, 24, 2, 1);
    sprite(dress, 11, 31);
    rect(colors.l, 17, 35, 2, 1);
    rect(colors.p, 14, 39, 1, 1);
    rect(colors.p, 21, 39, 1, 1);
    for (const offset of [-1, 1]) {
      const shoe = 16 + 3 * offset + stride * offset;
      rect(colors.k, shoe, 40, 5, 4 - stride * offset);
      rect(colors.w, shoe + 1, 40, 3, 1);
    }
    sprite(face, 9, 18);
    if (blink || ['wink', 'sleep', 'laugh'].includes(pose)) {
      for (const eye of pose === 'wink' ? [13] : [13, 18]) {
        rect(colors.s, eye, 24, 4, 3);
        rect(colors.d, eye + 1, 25, 3, 1);
      }
    }
    if (pose === 'blush') {
      rect(colors.b, 11, 27, 4, 2);
      rect(colors.b, 22, 27, 4, 2);
    }
    if (pose === 'gasp' || pose === 'spook') rect(colors.k, 17, 28, 2, 2);
    if (pose === 'pout') rect(colors.d, 16, 29, 4, 1);
    if (pose === 'laugh') rect(colors.r, 16, 28, 4, 2);
    if (pose === 'shake-dizzy' || pose === 'shake-sick') {
      for (const eye of [13, 18]) {
        rect(colors.s, eye, 23, 4, 4);
        sprite(pose === 'shake-dizzy' ? ['vvv.', 'v.v.', 'vv..'] : ['k..k', '.kk.', 'k..k'], eye, 24);
      }
      if (pose === 'shake-sick') {
        rect('#a9c984', 11, 27, 3, 2);
        rect('#a9c984', 22, 27, 3, 2);
        rect(colors.k, 15, 28, 3, 2);
      }
    }
    if (activity) paintActivityFace(activity.reaction.face, activity.look * facing, activity.elapsed);
    sprite(hat, 9, 10);
    rect(colors.l, 16, 14, 1, 1);
    rect(colors.l, 18, 14, 1, 1);
    const umbrellaX = mode === 'fly' ? 23 : 28;
    const tilt = activityTilt ?? (pose === 'spin' ? Math.sin(reactionTime / 100) * .37
      : mode === 'idle' ? Math.sin(t / 280) * .22 : -.16);
    parasol(umbrellaX, mode === 'fly' ? 2 : 8, tilt);
    const wave = mode === 'summon' ? Math.round(Math.sin(t / 100) * 3)
      : pose === 'wave' ? Math.round(Math.sin(reactionTime / 100) * 3) : 0;
    if (pose === 'wave') {
      rect(colors.k, 7, 29 + wave, 5, 3);
      rect(colors.s, 7, 29 + wave, 2, 2);
    }
    rect(colors.k, 23, 28 + wave, 6, 3);
    rect(colors.s, 26, 28 + wave, 2, 2);
    paintShakeReaction(pose, t, action.duration);
    pixels.restore();
    pixels.restore();

    if (mode === 'summon') {
      const progress = clamp(t / action.duration, 0, 1);
      pixels.globalAlpha = Math.min(1, progress * 7, (1 - progress) * 6);
      const rise = Math.round(20 * progress);
      const drift = Math.round(9 * progress);
      const ghostX = facing > 0 && x < innerWidth - 65 ? 48 + Math.floor(drift / 3) : 1 + drift;
      sprite(ghost, ghostX, 28 - rise);
      rect(colors.h, ghostX + 15, 25 - rise, 1, 3);
      rect(colors.h, ghostX + 14, 26 - rise, 3, 1);
      pixels.globalAlpha = 1;
    }
    if (expression?.mark) {
      const progress = reactionTime / (action.reaction ? action.duration : feedback.duration);
      const markX = x < innerWidth - 76 ? 47 : 2;
      pixels.globalAlpha = Math.min(1, (1 - progress) * 5);
      sprite(expression.mark, markX + Math.round(Math.sin(reactionTime / 180) * 2), 22 - Math.round(progress * 13));
      pixels.globalAlpha = 1;
    }
    if (activity) {
      pixels.globalAlpha = Math.min(1, (1 - progress) * 6);
      paintActivityProp(activity.kind, activity.reaction.prop, progress, activity.elapsed, activity.look);
      pixels.globalAlpha = 1;
    }
  }

  function keepInside() {
    x = clamp(x, 40, innerWidth - 40);
    y = clamp(y, 72, innerHeight - 7);
  }

  function place() {
    keepInside();
    pet.style.transform = 'translate3d(' + Math.round(x) + 'px, ' + Math.round(y) + 'px, 0) translate(-50%, -84.3%)';
  }

  function play(kind) {
    const moving = kind === 'walk' || kind === 'fly';
    const targetX = moving ? random(40, innerWidth - 40) : x;
    const targetY = moving ? random(72, innerHeight - 14) : y;
    const distance = Math.hypot(x - targetX, y - targetY);
    const duration = moving ? clamp(distance / (kind === 'fly' ? .16 : .1), 950, 6500)
      : kind === 'summon' ? 1900 : random(1400, 3800);
    action = { kind, duration, elapsed: 0, x, y, targetX, targetY };
    if (moving && Math.abs(targetX - x) > 4) facing = targetX > x ? 1 : -1;
    paint();
  }

  function nextAction() {
    const roll = Math.random();
    if (action.kind !== 'idle' && roll < .66) play('idle');
    else play(roll < .18 ? 'summon' : roll < .48 ? 'fly' : 'walk');
  }

  function react() {
    const count = reactions.length;
    const index = lastReaction < 0 ? Math.floor(random(0, count))
      : (lastReaction + 1 + Math.floor(random(0, count - 1))) % count;
    lastReaction = index;
    playReaction(reactions[index]);
  }

  function playReaction(reaction) {
    action = { kind: 'reaction', reaction, elapsed: 0, duration: reaction.duration ?? 1050, manual: true };
    paint();
  }

  function trackShake(event) {
    const shake = drag.shake;
    if (shake.sick) return;
    const now = performance.now();
    const dx = event.clientX - shake.x;
    const dy = event.clientY - shake.y;
    const distance = Math.hypot(dx, dy);
    if (now - shake.at > 220) {
      shake.direction = null;
      shake.turns = 0;
      shake.x = event.clientX;
      shake.y = event.clientY;
      shake.at = now;
      return;
    }
    if (distance < 22) return;
    const direction = [dx / distance, dy / distance];
    if (shake.direction) {
      const alignment = direction[0] * shake.direction[0] + direction[1] * shake.direction[1];
      if (alignment < -.65) {
        if (now - shake.turnAt > 290) shake.turns = 0;
        shake.turnAt = now;
        shake.turns++;
        if (shake.turns >= shake.sickAt) {
          shake.sick = true;
          playReaction(shakeReactions.sick);
        } else if (shake.turns >= shake.dizzyAt && !shake.dizzy) {
          shake.dizzy = true;
          playReaction(shakeReactions.dizzy);
        }
      }
    }
    shake.direction = direction;
    shake.x = event.clientX;
    shake.y = event.clientY;
    shake.at = now;
  }

  function notice(kind, immediate = false, target) {
    const reaction = activityReactions[kind];
    if (!reaction || drag || (action.reaction && !immediate)) return;
    const now = performance.now();
    if (!immediate && (((feedback && feedback.elapsed < 240) && !['send', 'answer', 'resize', 'move'].includes(kind))
        || now - (lastActivity.get(kind) ?? -Infinity) < 1100)) return;
    lastActivity.set(kind, now);
    const bounds = target?.getBoundingClientRect();
    const look = bounds ? Math.sign(bounds.left + bounds.width / 2 - x) : facing;
    feedback = { kind, reaction, look, elapsed: 0, duration: kind === 'command' ? 850 : 720 };
    paint();
  }

  function animate(time) {
    requestAnimationFrame(animate);
    if (time - previousTime < 30) return;
    const delta = Math.min(time - previousTime, 66);
    previousTime = time;
    const menuOpen = contextMenu.matches(':popover-open');
    if (document.hidden || (drag && !action.reaction)) return;
    if (feedback) {
      feedback.elapsed += delta;
      if (feedback.elapsed >= feedback.duration) feedback = undefined;
      paint();
    }
    if (menuOpen || document.querySelector('dialog[open]') || (reducedMotion.matches && !action.manual)) return;
    action.elapsed = Math.min(action.duration, action.elapsed + delta);
    if (action.kind === 'walk' || action.kind === 'fly') {
      const p = action.elapsed / action.duration;
      x = action.x + (action.targetX - action.x) * p;
      y = action.y + (action.targetY - action.y) * p;
      if (action.kind === 'fly') y -= Math.sin(Math.PI * p) * 78;
      place();
    }
    paint();
    if (action.elapsed === action.duration) {
      if (drag || action.reaction || reducedMotion.matches) play('idle');
      else nextAction();
    }
  }

  function actions(event) {
    notice('petMenu', true);
    showContextMenu(event, [
      ['Walk', () => choose('walk')],
      ['Idle', () => choose('idle')],
      ['Fly with parasol', () => choose('fly')],
      ['Summon a ghost', () => choose('summon')]
    ], hit);
  }

  function choose(kind) {
    play(kind);
    action.manual = true;
    notice('command', true);
  }

  hit.setAttribute('aria-haspopup', 'menu');
  hit.addEventListener('contextmenu', actions);
  hit.addEventListener('click', event => { if (event.detail === 0) actions(event); });
  hit.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    hit.setPointerCapture(event.pointerId);
    const dizzyAt = Math.floor(random(3, 6));
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
      offsetX: event.clientX - x, offsetY: event.clientY - y, moved: false,
      shake: { x: event.clientX, y: event.clientY, at: performance.now(), turnAt: -Infinity,
        turns: 0, dizzyAt, sickAt: dizzyAt + Math.floor(random(4, 8)) } };
  });
  hit.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
      drag.moved = true;
      pet.dataset.dragging = '';
      syncPreview();
      react();
    }
    x = event.clientX - drag.offsetX;
    y = event.clientY - drag.offsetY;
    place();
    trackShake(event);
  });
  function finishPickup(event, clicked) {
    if (drag?.id !== event.pointerId) return;
    const wasMoved = drag.moved;
    drag = undefined;
    delete pet.dataset.dragging;
    syncPreview();
    if (clicked && (!wasMoved || !action.reaction)) react();
    else if (!action.reaction) play('idle');
  }
  hit.addEventListener('pointerup', event => finishPickup(event, true));
  hit.addEventListener('pointercancel', event => finishPickup(event, false));
  hit.addEventListener('lostpointercapture', event => finishPickup(event, false));
  document.addEventListener('perona-activity', event => notice(event.detail.kind, false, event.detail.target));
  document.addEventListener('input', event => {
    if (event.target.closest('.agent-terminal')) notice('chat', false, event.target);
    else if (event.target.closest('.file-editor')) notice('edit', false, event.target);
    else notice('control', false, event.target);
  }, true);
  document.addEventListener('click', event => {
    if (event.target.closest('.perona-pet, .context-menu, .file-editor, .terminal-pane')) return;
    if (event.target.closest('.file-save')) notice('save', false, event.target);
    else if (event.target.closest('[data-view], .chat-link, .file-entry, .file-tab-select')) notice('navigation', false, event.target);
    else if (event.target.closest('button, summary, select, a')) notice('control', false, event.target);
  }, true);
  document.addEventListener('contextmenu', event => {
    if (!event.target.closest('.perona-pet')) notice('menu');
  }, true);
  document.addEventListener('keydown', event => {
    if (event.target.closest('.agent-terminal')) notice('chat', false, event.target);
    else if (event.target.closest('.terminal-pane')) notice('terminal');
    else if ((event.ctrlKey || event.altKey || event.metaKey) && !event.repeat) notice('control');
  }, true);
  document.addEventListener('wheel', () => notice('scroll'), { passive: true, capture: true });
  for (const type of ['dragstart', 'drop', 'lostpointercapture']) {
    document.addEventListener(type, event => {
      if (event.target.closest('.file-entry, .file-list, .file-location')) notice('fileMove', false, event.target);
      else if (event.target.closest('.dock-pane, .dock-divider, .project-dock')) notice('layout', false, event.target);
    }, true);
  }
  window.addEventListener('resize', () => {
    place();
    notice('resize');
  });
  window.desk.onWindowMoved(() => notice('move'));
  place();
  play('idle');
  requestAnimationFrame(animate);
})();
