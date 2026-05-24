#!/usr/bin/env node

/**
 * fetch-paperclip-report.js — PaperClip 이슈의 리포트를 로컬 워크스페이스에 캡쳐
 *
 * 마케팅 → CEO → Producer 자동 브릿지의 1단계.
 * Marketing Analyst가 PaperClip(localhost:3100)에 작성한 리포트를
 *   workspace/intel/marketing/<identifier>.json
 * 형태로 떠와서 이후 단계(ceo-analyze-marketing.js)가 오프라인으로 분석할 수 있도록 한다.
 *
 * Usage:
 *   node fetch-paperclip-report.js --issue YOU-99
 *   node fetch-paperclip-report.js --issue-id 43922380-d886-4e2b-8983-e523e10986e4
 *   node fetch-paperclip-report.js --issue YOU-99 --out workspace/intel/marketing/YOU-99.json
 *   node fetch-paperclip-report.js --issue YOU-99 --base-url http://localhost:3100
 *
 * Flags:
 *   --issue       <identifier>   ex. YOU-99 (PaperClip API의 by-identifier lookup)
 *   --issue-id    <uuid>         이슈 UUID 직접 지정
 *   --base-url    <url>          PaperClip API base. 기본 PAPERCLIP_BASE_URL || http://localhost:3100
 *   --company-id  <uuid>         회사 ID. 기본 BarroTube
 *   --out         <path>         출력 JSON. 기본 workspace/intel/marketing/<identifier>.json
 *   --report-key  <key>          documents에서 가져올 key (기본 'report')
 *   --quiet                      stdout 출력 최소화
 *
 * Exit codes:
 *   0  성공
 *   10 잘못된 인자 / API base 미설정
 *   11 이슈 fetch 실패 (네트워크 / 404)
 *   12 documents fetch 실패
 *   13 report 문서 부재 또는 비어 있음
 *   14 파일 쓰기 실패
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_BASE_URL = process.env.PAPERCLIP_BASE_URL || 'http://localhost:3100';
const DEFAULT_COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de'; // BarroTube
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

function logUnless(quiet, ...args) {
  if (!quiet) console.log(...args);
}

function assertAllowedHost(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch { throw new Error(`Invalid --base-url: ${baseUrl}`); }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing to call PaperClip on non-internal host: ${parsed.hostname}.\n` +
      `Whitelist (paperclip/config/domain-whitelist.json): 127.0.0.1, localhost.`
    );
  }
  return parsed;
}

async function getJson(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`GET ${url} → ${res.status}: ${body.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function resolveIssueId({ identifier, issueId, baseUrl, companyId, quiet }) {
  if (issueId) return issueId;
  if (!identifier) throw new Error('Either --issue (identifier) or --issue-id (uuid) is required.');

  // 1) GET /api/issues/<identifier> — 일부 PaperClip 빌드는 identifier 직접 허용
  try {
    const data = await getJson(`${baseUrl}/api/issues/${encodeURIComponent(identifier)}`);
    if (data?.id) return data.id;
  } catch (e) {
    logUnless(quiet, `  · /api/issues/${identifier} 직접 조회 실패 (${e.status || 'net'}). list 검색으로 fallback.`);
  }

  // 2) Fallback: /api/issues?companyId=...&identifier=...
  try {
    const url = `${baseUrl}/api/issues?companyId=${companyId}&limit=200`;
    const list = await getJson(url);
    const items = Array.isArray(list) ? list : (list.items || list.data || []);
    const hit = items.find(i => i.identifier === identifier);
    if (hit) return hit.id;
  } catch (e) {
    throw new Error(`Issue identifier resolve 실패: ${identifier} (${e.message})`);
  }
  throw new Error(`Issue identifier not found: ${identifier}`);
}

async function fetchAll({ identifier, issueId, baseUrl, companyId, reportKey, quiet }) {
  const id = await resolveIssueId({ identifier, issueId, baseUrl, companyId, quiet });
  logUnless(quiet, `🔎 issue uuid: ${id}`);

  let issue;
  try {
    issue = await getJson(`${baseUrl}/api/issues/${id}`);
  } catch (e) {
    const err = new Error(`이슈 조회 실패: ${e.message}`);
    err.exitCode = 11;
    throw err;
  }

  let documents = [];
  try {
    documents = await getJson(`${baseUrl}/api/issues/${id}/documents`);
    if (!Array.isArray(documents)) documents = [];
  } catch (e) {
    const err = new Error(`이슈 documents 조회 실패: ${e.message}`);
    err.exitCode = 12;
    throw err;
  }

  let comments = [];
  try {
    comments = await getJson(`${baseUrl}/api/issues/${id}/comments`);
    if (!Array.isArray(comments)) comments = [];
  } catch (e) {
    // comments 부재는 치명적이지 않음
    logUnless(quiet, `  ⚠ comments 조회 실패: ${e.message} (계속 진행)`);
  }

  const reportDoc = documents.find(d => d.key === reportKey) || documents[0];
  if (!reportDoc || !reportDoc.body || reportDoc.body.length < 50) {
    const err = new Error(`report 문서가 비어 있거나 키 '${reportKey}'를 찾을 수 없음 (docs=${documents.length})`);
    err.exitCode = 13;
    throw err;
  }

  return { issue, documents, comments, reportDoc };
}

async function main() {
  const { values } = parseArgs({
    options: {
      issue:        { type: 'string' },
      'issue-id':   { type: 'string' },
      'base-url':   { type: 'string' },
      'company-id': { type: 'string' },
      out:          { type: 'string', short: 'o' },
      'report-key': { type: 'string' },
      quiet:        { type: 'boolean', default: false },
    },
  });

  const quiet     = values.quiet;
  const baseUrl   = (values['base-url'] || DEFAULT_BASE_URL).replace(/\/$/, '');
  const companyId = values['company-id'] || DEFAULT_COMPANY_ID;
  const reportKey = values['report-key'] || 'report';

  if (!values.issue && !values['issue-id']) {
    console.error('Usage: fetch-paperclip-report.js --issue YOU-99 [--out path]');
    process.exit(10);
  }

  try {
    assertAllowedHost(baseUrl);
  } catch (e) {
    console.error('❌', e.message);
    process.exit(10);
  }

  let bundle;
  try {
    bundle = await fetchAll({
      identifier: values.issue,
      issueId:    values['issue-id'],
      baseUrl, companyId, reportKey, quiet,
    });
  } catch (e) {
    console.error('❌', e.message);
    process.exit(e.exitCode || 11);
  }

  const identifier = bundle.issue.identifier || values.issue || bundle.issue.id;
  const outPath = values.out
    ? resolve(values.out)
    : join(ROOT, 'workspace/intel/marketing', `${identifier}.json`);

  const payload = {
    fetched_at: new Date().toISOString(),
    source: { base_url: baseUrl, company_id: companyId },
    issue: {
      id: bundle.issue.id,
      identifier: bundle.issue.identifier,
      issueNumber: bundle.issue.issueNumber,
      title: bundle.issue.title,
      description: bundle.issue.description,
      status: bundle.issue.status,
      priority: bundle.issue.priority,
      assigneeAgentId: bundle.issue.assigneeAgentId,
      createdByAgentId: bundle.issue.createdByAgentId,
      createdAt: bundle.issue.createdAt,
      completedAt: bundle.issue.completedAt,
      parentId: bundle.issue.parentId,
      ancestors: bundle.issue.ancestors || [],
    },
    report: {
      key: bundle.reportDoc.key,
      title: bundle.reportDoc.title,
      format: bundle.reportDoc.format,
      latestRevisionNumber: bundle.reportDoc.latestRevisionNumber,
      body: bundle.reportDoc.body,
      length: bundle.reportDoc.body.length,
    },
    documents: bundle.documents.map(d => ({
      id: d.id, key: d.key, title: d.title, format: d.format,
      latestRevisionNumber: d.latestRevisionNumber,
      bodyLength: (d.body || '').length,
    })),
    comments: bundle.comments.map(c => ({
      id: c.id, authorAgentId: c.authorAgentId, body: c.body, createdAt: c.createdAt,
    })),
  };

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (e) {
    console.error(`❌ 파일 쓰기 실패: ${e.message}`);
    process.exit(14);
  }

  logUnless(quiet, `✅ ${identifier} → ${outPath} (report ${payload.report.length} chars, comments ${payload.comments.length})`);
  if (!quiet) {
    console.log(`<!--RESULT-->${JSON.stringify({
      ok: true, identifier, issue_id: bundle.issue.id, out: outPath,
      report_length: payload.report.length, comments: payload.comments.length,
    })}<!--/RESULT-->`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message || e); process.exit(11); });
}

export { fetchAll, resolveIssueId };
