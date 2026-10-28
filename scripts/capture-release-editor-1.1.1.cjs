#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGroup } = require('./verify-prior-deliveries-ui.cjs');

const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'docs', 'releases', '1.1.1', 'assets');
const provenanceFile = path.join(assetsDir, '..', 'PROVENANCE-EDITOR.md');
const candidateFile = path.join(projectRoot, 'docs', 'evidence', 'stabilization-1.1.1', 'check-candidate.json');
const ffmpeg = 'C:\\Users\\clove\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
const ffprobe = 'C:\\Users\\clove\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe';
const prefix = 'editor-release-1-1-1';
const outputNames = [
  'editor-icon-picker-layering.gif',
  'editor-icon-picker-layering.png',
  'editor-icon-column-result.png',
];
const createdOutputs = [];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Esperava uma captura PNG.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function assertTempPath(directory, expectedPrefix) {
  const root = path.resolve(directory);
  const relative = path.relative(path.resolve(os.tmpdir()), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'A limpeza deve ficar restrita ao diretório temporário.');
  assert.ok(path.basename(root).startsWith(expectedPrefix), 'A limpeza só pode remover a pasta criada por esta execução.');
  return root;
}

function makeGif(frameFiles, target, workDir, crop) {
  const croppedFrames = frameFiles.map((file, index) => {
    const output = path.join(workDir, 'cropped-' + String(index + 1).padStart(2, '0') + '.png');
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-vf', 'crop=' + crop.width + ':' + crop.height + ':' + crop.x + ':' + crop.y,
      '-frames:v', '1',
      output,
    ], { stdio: 'pipe' });
    return output;
  });

  const concatPath = path.join(workDir, 'frames.ffconcat');
  const lines = [];
  for (let index = 0; index < croppedFrames.length; index++) {
    lines.push("file '" + path.basename(croppedFrames[index]) + "'");
    lines.push('duration ' + (index === croppedFrames.length - 1 ? '3.5' : '3'));
  }
  lines.push("file '" + path.basename(croppedFrames[croppedFrames.length - 1]) + "'");
  fs.writeFileSync(concatPath, lines.join('\n') + '\n', 'utf8');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-filter_complex', 'fps=12,scale=min(1000\\,iw):-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer',
    '-vsync', 'vfr', '-loop', '0', target,
  ], { cwd: workDir, stdio: 'pipe' });
}

function copyNew(source, name) {
  const target = path.join(assetsDir, name);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  createdOutputs.push(target);
  return target;
}

function writeProvenance(candidate, report, measurements, files) {
  const ticket = report.tickets['#37'];
  const launches = ticket.compiledBuildIdentity;
  const artifactHashes = [
    launches.initialLaunch.beforeLaunch.artifactContentSha256,
    launches.reopenedLaunch.beforeLaunch.artifactContentSha256,
  ];
  const lines = [
    '# Proveniência das capturas do editor — Morrow fork 1.1.1',
    '',
    '## Build e isolamento',
    '',
    '- Versão do candidato: ' + candidate.version + '.',
    '- Commit candidato: ' + candidate.candidateCommit + '.',
    '- Base Morrow: ' + candidate.baseVersion + '; commit ' + JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).morrowBaseCommit + '.',
    '- Hash do conjunto de fontes validado pelo gate: ' + candidate.sourceAfter.sha256 + ' (' + candidate.sourceAfter.fileCount + ' arquivos).',
    '- Fingerprint dos artefatos Electron: ' + artifactHashes[0] + '; reabertura: ' + artifactHashes[1] + '.',
    '- Reexecução real em Electron oculto, com vault e perfil sintéticos isolados. O relatório da captura marcou todas as janelas como ocultas e registrou ' + report.pageErrors.length + ' pageerror.',
    '- Os arquivos de origem das capturas e os perfis sintéticos foram removidos da pasta temporária após gerar os materiais finais.',
    '',
    '## Roteiro reproduzível',
    '',
    '1. Abrir a tabela sintética e as configurações da propriedade.',
    '2. Abrir o seletor de ícones sobre as configurações e conferir o foco após fechá-lo.',
    '3. Enviar o retrato raster sintético portrait-200x400.png por um input de arquivo interceptado pelo Playwright.',
    '4. Conferir o retrato de 200 × 400 pixels como glifo de 14 × 14 no cabeçalho e no espaço de 32 × 32 das configurações.',
    '5. Alterar o tipo da propriedade, reabrir o aplicativo e confirmar o ícone da propriedade e o ícone original da página.',
    '',
    'O GIF usa estados reais capturados durante a sequência e na reabertura; não é uma animação de interface simulada.',
    '',
    '## Arquivos, legendas e texto alternativo',
    '',
    '- ' + files.gif.name + ' — GIF, ' + files.gif.width + ' × ' + files.gif.height + ' px, ' + files.gif.durationSeconds + ' s, ' + files.gif.bytes + ' bytes, SHA-256 ' + files.gif.sha256 + '. Legenda: “O seletor abre acima das configurações; após o envio, o retrato alto aparece ajustado no cabeçalho e continua salvo ao reabrir.” Texto alternativo: “Sequência da interface do Morrow mostrando o seletor de ícones sobre as configurações, o retrato sintético no cabeçalho e o ícone persistido após reabrir.”',
    '- ' + files.layering.name + ' — PNG, ' + files.layering.bytes + ' bytes, SHA-256 ' + files.layering.sha256 + '. Legenda: “Seletor de ícones sobre as configurações da propriedade.” Texto alternativo: “Seletor de ícones aberto acima do painel da coluna na tabela sintética.”',
    '- ' + files.result.name + ' — PNG, ' + files.result.bytes + ' bytes, SHA-256 ' + files.result.sha256 + '. Legenda: “Retrato de 200 × 400 ajustado no cabeçalho da propriedade.” Texto alternativo: “Cabeçalho da coluna Value type test exibindo o retrato sintético em tamanho de glifo.”',
    '',
    'As telas, propriedades e arquivos enviados são sintéticos; nenhuma vault pessoal foi usada.',
    '',
  ];
  const target = provenanceFile;
  fs.writeFileSync(target, lines.join('\n'), { encoding: 'utf8', flag: 'wx' });
  createdOutputs.push(target);
  return { artifactHashes, rasterMetrics: ticket.checks.uploadedIcons.rasterHeaderMetrics, settingsSlot: ticket.checks.uploadedIcons.rasterSettingsSlot, measurements };
}

async function main() {
  assert.equal(fs.existsSync(provenanceFile), false, 'Recusando sobrescrever proveniência existente.');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const name of outputNames) {
    assert.equal(fs.existsSync(path.join(assetsDir, name)), false, 'Recusando sobrescrever arquivo existente: ' + name);
  }

  const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  assert.equal(head, candidate.candidateCommit);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version, candidate.version);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-editor-release-'));
  const editorEvidenceDir = path.join(tempRoot, 'editor-captures');
  fs.mkdirSync(editorEvidenceDir);
  const evidencePrefix = prefix + '-' + Date.now().toString(36);
  process.env.MORROW_EDITOR_EVIDENCE_DIR = editorEvidenceDir;
  process.env.MORROW_EDITOR_EVIDENCE_PREFIX = evidencePrefix;
  process.env.MORROW_UI_BUILD_HEAD = candidate.candidateCommit;
  process.env.MORROW_UI_BUILD_INPUT_FINGERPRINT = candidate.sourceAfter.sha256;

  let fixtureRoot = null;
  try {
    const report = await runGroup('delivery3', ['#37']);
    fixtureRoot = report.syntheticFixturesRoot;
    assert.equal(report.overall, 'passed', 'O fluxo de ícone precisa passar na interface real e após a reabertura.');
    assert.equal(report.tickets['#37'].status, 'passed');
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.allWindowsStayedHidden, true);
    assert.equal(report.compiledArtifactStableAcrossLaunches, true);
    assert.equal(report.buildFingerprint.sourceInputsSha256, candidate.sourceAfter.sha256);

    const screenshot = (name) => path.join(editorEvidenceDir, evidencePrefix + '-' + name + '.png');
    const sources = [
      screenshot('icon-dialog-over-property-settings'),
      screenshot('raster-column-header-14px'),
      screenshot('raster-settings-slot-32px'),
      screenshot('raster-settings-after-reopen'),
    ];
    for (const file of sources) assert.equal(fs.existsSync(file), true, 'Captura real ausente: ' + path.basename(file));
    const sourceSize = pngDimensions(sources[0]);
    for (const file of sources.slice(1)) assert.deepEqual(pngDimensions(file), sourceSize);
    const crop = {
      width: Math.min(1120, sourceSize.width),
      height: Math.min(960, sourceSize.height),
      x: Math.floor(Math.max(0, (sourceSize.width - Math.min(1120, sourceSize.width)) / 2 + 5)),
      y: Math.floor(Math.min(20, Math.max(0, sourceSize.height - Math.min(960, sourceSize.height)))),
    };
    assert.ok(crop.width >= 900, 'A área recortada deve preservar texto legível.');
    const layeredFinal = path.join(tempRoot, outputNames[1]);
    const resultFinal = path.join(tempRoot, outputNames[2]);
    const cropScreenshot = (source, destination) => execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-vf', 'crop=' + crop.width + ':' + crop.height + ':' + crop.x + ':' + crop.y,
      '-frames:v', '1', destination,
    ], { stdio: 'pipe' });
    cropScreenshot(sources[0], layeredFinal);
    cropScreenshot(sources[1], resultFinal);

    const gifTemp = path.join(tempRoot, outputNames[0]);
    makeGif(sources, gifTemp, tempRoot, crop);
    const probe = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=width,height',
      '-select_streams', 'v:0',
      '-of', 'json',
      gifTemp,
    ], { encoding: 'utf8' }));
    const gifStream = probe.streams[0];
    const durationSeconds = Math.round(Number(probe.format.duration) * 10) / 10;
    const gifBytes = fs.statSync(gifTemp).size;
    assert.ok(durationSeconds >= 9 && durationSeconds <= 18);
    assert.ok(gifStream.width <= 1100);
    assert.ok(gifBytes < 3 * 1024 * 1024, 'O GIF final deve ficar abaixo de 3 MB.');

    const finalGif = copyNew(gifTemp, outputNames[0]);
    const finalLayering = copyNew(layeredFinal, outputNames[1]);
    const finalResult = copyNew(resultFinal, outputNames[2]);
    const fileInfo = (file, name, extra = {}) => ({
      name,
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
      ...extra,
    });
    const files = {
      gif: fileInfo(finalGif, outputNames[0], {
        width: gifStream.width,
        height: gifStream.height,
        durationSeconds,
      }),
      layering: fileInfo(finalLayering, outputNames[1]),
      result: fileInfo(finalResult, outputNames[2]),
    };
    const measurements = {
      sourceScreenshot: sourceSize,
      crop,
      captureFrameCount: sources.length,
      interaction: report.tickets['#37'].checks.uploadedIcons,
      reopening: report.tickets['#37'].checks.rasterTypeAndIconAfterReopen,
    };
    const extras = writeProvenance(candidate, report, measurements, files);
    console.log(JSON.stringify({
      status: 'passed',
      version: candidate.version,
      commit: candidate.candidateCommit,
      build: extras.artifactHashes,
      hidden: report.allWindowsStayedHidden,
      pageErrors: report.pageErrors,
      measurements,
      files,
    }, null, 2));
  } catch (error) {
    for (const file of createdOutputs) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Keep the original capture error.
      }
    }
    throw error;
  } finally {
    if (fixtureRoot) {
      const root = assertTempPath(fixtureRoot, 'morrow-delivery3-ui-');
      fs.rmSync(root, { recursive: true, force: true });
    }
    const root = assertTempPath(tempRoot, 'morrow-editor-release-');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
