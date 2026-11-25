'use strict';

const { Contract } = require('fabric-contract-api');

const STRICT_AUTH = false;
const DATA_HASH_RE = /^[a-f0-9]{64}$/i;

const SYSTEM_FIELDS = new Set([
    'certificateId', 'documentName', 'issuer', 'issuerId', 'metadata', 'ipfsData',
    'cid', 'dataHash', 'status', 'version', 'anchoredTxId', 'previousTxId',
    'lastTxId', 'txSubmitter', 'txTimestamp', 'reason', 'replacedBy', 'revokedAt'
]);

class CertificateContract extends Contract {

    async issueCertificate(ctx, certificateJsonString) {
        const certData = this._parse(certificateJsonString);
        const issuerId = this._str(
            certData.issuerId || (certData.issuer && certData.issuer.issuerId),
            'issuer.issuerId'
        );
        const dataHash = this._dataHash(
            certData.dataHash || (certData.metadata && certData.metadata.dataHash)
        );

        this._authorize(ctx, issuerId);

        if (certData.certificateId) {
            return this._correct(
                ctx,
                certData,
                this._str(certData.certificateId, 'certificateId'),
                issuerId,
                dataHash
            );
        }
        return this._firstIssue(ctx, certData, issuerId, dataHash);
    }

    async revokeCertificate(ctx, certificateId, reason) {
        certificateId = this._str(certificateId, 'certificateId');

        const starting = await this._read(ctx, this._certKey(ctx, certificateId));
        if (!starting) throw new Error(`The certificate ${certificateId} does not exist`);

        this._authorize(ctx, this._issuerOf(starting));

        const tip = await this._tip(ctx, starting);
        if (!tip) throw new Error(`Document ${starting.documentName} points at a missing tip`);
        if ((tip.status || 'ACTIVE') === 'REVOKED') {
            return this._ok(tip, 'Certificate is already revoked', {
                requestedCertificateId: certificateId,
                revokedCertificateId: tip.certificateId
            });
        }

        const now = this._now(ctx);
        const txId = ctx.stub.getTxID();
        const revokeReason = reason || '';
        const submitter = ctx.clientIdentity.getID();

        tip.status = 'REVOKED';
        tip.reason = revokeReason;
        tip.revokedAt = now;
        tip.txTimestamp = now;
        tip.lastTxId = txId;
        tip.txSubmitter = submitter;

        await ctx.stub.putState(this._certKey(ctx, tip.certificateId), Buffer.from(JSON.stringify(tip)));
        await this._cascadeRevoke(ctx, tip.previousTxId, revokeReason, now, txId, submitter);

        return this._ok(tip, 'Certificate revoked', {
            requestedCertificateId: certificateId,
            revokedCertificateId: tip.certificateId
        });
    }

    async readCertificate(ctx, certificateId) {
        const bytes = await ctx.stub.getState(this._certKey(ctx, certificateId));
        if (!bytes || !bytes.length) {
            throw new Error(`The certificate ${certificateId} does not exist`);
        }
        return bytes.toString('utf8');
    }

    async readCertificateByDocumentName(ctx, issuerId, documentName) {
        issuerId = this._str(issuerId, 'issuerId');
        documentName = this._str(documentName, 'documentName');

        const ref = await ctx.stub.getState(this._docKey(ctx, issuerId, documentName));
        if (!ref || !ref.length) {
            throw new Error(`No certificate is anchored for document ${documentName}`);
        }
        return this.readCertificate(ctx, ref.toString('utf8'));
    }

    async verifyCertificate(ctx, certificateId, dataHash) {
        certificateId = this._str(certificateId, 'certificateId');
        dataHash = this._str(dataHash, 'dataHash');

        const current = await this._read(ctx, this._certKey(ctx, certificateId));
        if (!current) {
            return JSON.stringify({
                success: true, exists: false, valid: false,
                status: 'NOT_FOUND', certificateId, hashMatch: false
            });
        }

        const hashMatch = this._hashOf(current) === dataHash;
        const status = current.status || 'ACTIVE';
        const out = {
            success: true,
            exists: true,
            certificateId,
            version: current.version,
            hashMatch,
            replacedBy: current.replacedBy || ''
        };

        if (status === 'REVOKED') {
            return JSON.stringify({
                ...out, valid: false, status: 'REVOKED',
                reason: current.reason || '', revokedAt: current.revokedAt
            });
        }
        if (status === 'SUPERSEDED') {
            return JSON.stringify({ ...out, valid: false, status: 'SUPERSEDED' });
        }
        if (!hashMatch) {
            return JSON.stringify({ ...out, valid: false, status: 'TAMPERED' });
        }
        return JSON.stringify({ ...out, valid: true, status: 'ACTIVE' });
    }

    async getCertificatesByIssuer(ctx, issuerId) {
        issuerId = this._str(issuerId, 'issuerId');
        const iterator = await ctx.stub.getStateByPartialCompositeKey('Issuer~Cert', [issuerId]);
        const results = [];
        try {
            let done = false;
            while (!done) {
                const res = await iterator.next();
                if (res.value && res.value.key) {
                    const id = ctx.stub.splitCompositeKey(res.value.key).attributes[1];
                    const cert = await this._read(ctx, this._certKey(ctx, id));
                    if (cert) results.push(cert);
                }
                done = res.done;
            }
        } finally {
            await iterator.close();
        }
        return JSON.stringify(results);
    }

    async getCertificatesByIssuerPaged(ctx, issuerId, pageSize, bookmark) {
        issuerId = this._str(issuerId, 'issuerId');
        let size = parseInt(pageSize, 10);
        if (!Number.isFinite(size) || size < 1) size = 50;
        if (size > 200) size = 200;

        const { iterator, metadata } = await ctx.stub.getStateByPartialCompositeKeyWithPagination(
            'Issuer~Cert', [issuerId], size, bookmark || ''
        );

        const results = [];
        try {
            let done = false;
            while (!done) {
                const res = await iterator.next();
                if (res.value && res.value.key) {
                    const id = ctx.stub.splitCompositeKey(res.value.key).attributes[1];
                    const cert = await this._read(ctx, this._certKey(ctx, id));
                    if (cert) results.push(cert);
                }
                done = res.done;
            }
        } finally {
            await iterator.close();
        }

        return JSON.stringify({
            success: true,
            results,
            bookmark: (metadata && metadata.bookmark) || '',
            fetchedRecordsCount: (metadata && metadata.fetchedRecordsCount) || results.length
        });
    }

    async _firstIssue(ctx, certData, issuerId, dataHash) {
        const documentName = this._str(certData.documentName, 'documentName');
        const docKey = this._docKey(ctx, issuerId, documentName);
        const existingRef = await ctx.stub.getState(docKey);

        if (existingRef && existingRef.length) {
            const existing = await this._read(ctx, this._certKey(ctx, existingRef.toString('utf8')));
            if (!existing) throw new Error(`Document ${documentName} points at a missing certificate`);
            if ((existing.status || 'ACTIVE') === 'REVOKED') {
                return this._reissue(ctx, existing, certData, issuerId, dataHash);
            }
            return this._ok(existing, 'Certificate already anchored for this document');
        }

        const txId = ctx.stub.getTxID();
        const record = this._record(ctx, certData, {
            certificateId: txId,
            documentName,
            issuerId,
            dataHash,
            cid: this._cidOf(certData) || '',
            version: 1,
            anchoredTxId: txId,
            previousTxId: '',
            txId
        });

        await ctx.stub.putState(this._certKey(ctx, txId), Buffer.from(JSON.stringify(record)));
        await ctx.stub.putState(docKey, Buffer.from(txId));
        await this._indexIssuer(ctx, record);
        return this._ok(record, 'Successfully issued certificate');
    }

    async _reissue(ctx, revokedTip, certData, issuerId, dataHash) {
        const cid = this._cidOf(certData);
        if (!cid) throw new Error('Mandatory field missing: ipfsData.cid');

        const txId = ctx.stub.getTxID();
        const record = this._record(ctx, certData, {
            certificateId: txId,
            documentName: revokedTip.documentName,
            issuerId,
            dataHash,
            cid,
            version: (revokedTip.version || 1) + 1,
            anchoredTxId: revokedTip.anchoredTxId || revokedTip.certificateId,
            previousTxId: revokedTip.certificateId,
            txId
        });

        const docKey = this._docKey(ctx, issuerId, revokedTip.documentName);
        await ctx.stub.putState(this._certKey(ctx, txId), Buffer.from(JSON.stringify(record)));
        await ctx.stub.putState(docKey, Buffer.from(txId));
        await this._indexIssuer(ctx, record);
        return this._ok(record, 'Certificate re-issued after revoke');
    }

    async _correct(ctx, certData, certificateId, issuerId, dataHash) {
        const starting = await this._read(ctx, this._certKey(ctx, certificateId));
        if (!starting) throw new Error(`The certificate ${certificateId} does not exist`);

        if (this._issuerOf(starting) !== issuerId) {
            throw new Error('Issuer does not match the anchored certificate');
        }
        if ((starting.status || 'ACTIVE') === 'REVOKED') {
            throw new Error(`The certificate ${certificateId} is revoked`);
        }

        const tip = await this._tip(ctx, starting);
        if (!tip) throw new Error(`Document ${starting.documentName} points at a missing tip`);
        if ((tip.status || 'ACTIVE') === 'REVOKED') {
            throw new Error(`The certificate ${tip.certificateId} is revoked`);
        }
        if (this._hashOf(tip) === dataHash) {
            return this._ok(tip, 'Certificate already holds this data hash', {
                correctedFrom: certificateId,
                tipCertificateId: tip.certificateId
            });
        }

        const cid = this._cidOf(certData);
        if (!cid) throw new Error('Mandatory field missing: ipfsData.cid');

        const txId = ctx.stub.getTxID();
        const now = this._now(ctx);
        const record = this._record(ctx, certData, {
            certificateId: txId,
            documentName: tip.documentName,
            issuerId,
            dataHash,
            cid,
            version: (tip.version || 1) + 1,
            anchoredTxId: tip.anchoredTxId || tip.certificateId,
            previousTxId: tip.certificateId,
            txId
        });

        tip.status = 'SUPERSEDED';
        tip.replacedBy = txId;
        tip.lastTxId = txId;
        tip.txSubmitter = ctx.clientIdentity.getID();
        tip.txTimestamp = now;

        const resolvedTip = certificateId !== tip.certificateId;
        const message = resolvedTip
            ? 'Certificate corrected (resolved tip)'
            : 'Certificate corrected';

        const docKey = this._docKey(ctx, issuerId, tip.documentName);
        await ctx.stub.putState(this._certKey(ctx, tip.certificateId), Buffer.from(JSON.stringify(tip)));
        await ctx.stub.putState(this._certKey(ctx, txId), Buffer.from(JSON.stringify(record)));
        await ctx.stub.putState(docKey, Buffer.from(txId));
        await this._indexIssuer(ctx, record);
        return this._ok(record, message, {
            correctedFrom: certificateId,
            tipCertificateId: tip.certificateId
        });
    }

    async _cascadeRevoke(ctx, previousTxId, reason, revokedAt, txId, submitter) {
        let cursor = previousTxId || '';
        const seen = new Set();

        while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            const ancestor = await this._read(ctx, this._certKey(ctx, cursor));
            if (!ancestor) break;

            if ((ancestor.status || 'ACTIVE') !== 'REVOKED') {
                ancestor.status = 'REVOKED';
                ancestor.reason = reason;
                ancestor.revokedAt = revokedAt;
                ancestor.txTimestamp = revokedAt;
                ancestor.lastTxId = txId;
                ancestor.txSubmitter = submitter;
                await ctx.stub.putState(
                    this._certKey(ctx, ancestor.certificateId),
                    Buffer.from(JSON.stringify(ancestor))
                );
            }

            cursor = ancestor.previousTxId || '';
        }
    }

    _record(ctx, certData, f) {
        const extras = {};
        for (const [k, v] of Object.entries(certData || {})) {
            if (!SYSTEM_FIELDS.has(k) && v !== undefined) extras[k] = v;
        }

        return {
            ...extras,
            certificateId: f.certificateId,
            documentName: f.documentName,
            issuer: {
                ...(typeof certData.issuer === 'object' ? certData.issuer : {}),
                issuerId: f.issuerId
            },
            metadata: { ...(certData.metadata || {}), dataHash: f.dataHash },
            ipfsData: { ...(certData.ipfsData || {}), cid: f.cid },
            status: 'ACTIVE',
            version: f.version,
            anchoredTxId: f.anchoredTxId,
            previousTxId: f.previousTxId,
            lastTxId: f.txId,
            txSubmitter: ctx.clientIdentity.getID(),
            txTimestamp: this._now(ctx),
            reason: '',
            replacedBy: '',
            revokedAt: null
        };
    }

    async _tip(ctx, any) {
        const ref = await ctx.stub.getState(this._docKey(ctx, this._issuerOf(any), any.documentName));
        const tipId = (ref && ref.length) ? ref.toString('utf8') : any.certificateId;
        if (tipId === any.certificateId) return any;
        return this._read(ctx, this._certKey(ctx, tipId));
    }

    _authorize(ctx, expectedIssuerId) {
        const caller =
            ctx.clientIdentity.getAttributeValue('institutionId') ||
            ctx.clientIdentity.getAttributeValue('issuerId');

        if (!caller) {
            if (STRICT_AUTH) throw new Error('Unauthorized: missing institutionId attribute');
            return;
        }
        if (caller !== expectedIssuerId) {
            throw new Error(
                'Unauthorized: ledger issuerId must equal institutionId; re-issue or migrate legacy cert'
            );
        }
    }

    _parse(raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new Error(`Failed to parse JSON payload: ${err.message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Certificate payload must be a JSON object');
        }
        return parsed;
    }

    _str(value, name) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`Mandatory field missing or invalid: ${name}`);
        }
        return value;
    }

    _dataHash(value) {
        const hash = this._str(value, 'metadata.dataHash');
        if (!DATA_HASH_RE.test(hash)) {
            throw new Error('metadata.dataHash must be a 64-character hex SHA-256 digest');
        }
        return hash;
    }

    _issuerOf(r) { return (r.issuer && r.issuer.issuerId) || r.issuerId || ''; }
    _hashOf(r) { return (r.metadata && r.metadata.dataHash) || r.dataHash || ''; }
    _cidOf(d) { return (d.ipfsData && d.ipfsData.cid) || d.cid || ''; }

    _ok(record, message, extra) {
        return JSON.stringify({
            success: true,
            certificateId: record.certificateId,
            documentName: record.documentName,
            version: record.version,
            status: record.status || 'ACTIVE',
            txId: record.lastTxId,
            message,
            ...(extra || {})
        });
    }

    _certKey(ctx, id) { return ctx.stub.createCompositeKey('Cert', [id]); }
    _docKey(ctx, issuerId, documentName) {
        return ctx.stub.createCompositeKey('Doc', [issuerId, documentName]);
    }

    async _read(ctx, key) {
        const bytes = await ctx.stub.getState(key);
        if (!bytes || !bytes.length) return null;
        return JSON.parse(bytes.toString('utf8'));
    }

    async _indexIssuer(ctx, record) {
        const key = ctx.stub.createCompositeKey('Issuer~Cert', [
            this._issuerOf(record),
            record.certificateId
        ]);
        await ctx.stub.putState(key, Buffer.from('\u0000'));
    }

    _now(ctx) {
        const ts = ctx.stub.getTxTimestamp();
        return Math.floor(ts.seconds.toNumber ? ts.seconds.toNumber() : Number(ts.seconds));
    }
}

module.exports = CertificateContract;
