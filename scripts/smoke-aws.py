"""Integration / smoke test trên AWS dev (T15.7): gọi thẳng Lambda reloop-dev-api với JWT claims giả
(bỏ qua API Gateway), chạy trọn luồng đối tác → đăng tin → matching → báo giá → giao dịch → thông báo,
rồi dọn dữ liệu test. Vị trí test ở biển gần Cà Mau để không trùng dữ liệu thật.

Dùng:  AWS_PROFILE=reloop AWS_REGION=ap-southeast-1 python scripts/smoke-aws.py [--cleanup]
       Mặc định GIỮ dữ liệu test trên web (nhóm dùng để test / fix bug). --cleanup: tạm ngừng tài khoản test
       → tin test ẩn khỏi Chợ (không xóa gì).
"""
import json, os, struct, subprocess, sys, tempfile, urllib.parse, urllib.request, uuid, zlib

sys.stdout.reconfigure(encoding='utf-8')  # console Windows (cp1252) không in được tiếng Việt

SP = tempfile.mkdtemp(prefix='reloop-smoke-')
RUN = uuid.uuid4().hex[:6]
OWNER, PARTNER, ADMIN = f'smoke-owner-{RUN}', f'smoke-partner-{RUN}', f'smoke-admin-{RUN}'
SEA = {'lat': 8.45, 'lng': 104.6}  # biển gần Cà Mau — không trùng dữ liệu thật


def call(method, path, user, body=None, groups=None, idem=False):
    claims = {'sub': user}
    if groups:
        claims['cognito:groups'] = '[' + ' '.join(groups) + ']'
    headers = {'content-type': 'application/json'}
    if idem:
        headers['idempotency-key'] = uuid.uuid4().hex
    path, _, qs = path.partition('?')
    event = {
        'version': '2.0', 'rawPath': path, 'rawQueryString': qs, 'headers': headers,
        'queryStringParameters': dict(urllib.parse.parse_qsl(qs)),
        'body': json.dumps(body) if body is not None else None,
        'requestContext': {'http': {'method': method, 'path': path}, 'authorizer': {'jwt': {'claims': claims}}},
    }
    ev = os.path.join(SP, 'smoke_ev.json'); out = os.path.join(SP, 'smoke_out.json')
    with open(ev, 'w', encoding='utf8') as f:
        json.dump(event, f)
    subprocess.run(['aws', 'lambda', 'invoke', '--function-name', 'reloop-dev-api', '--cli-binary-format', 'raw-in-base64-out',
                    '--payload', 'file://' + ev.replace('\\', '/'), out], check=True, capture_output=True, shell=(os.name == 'nt'))
    r = json.load(open(out, encoding='utf8'))
    return r['statusCode'], json.loads(r.get('body') or 'null')



def upload_png(user):
    """Upload 1 ảnh PNG nhỏ qua presigned POST rồi gọi kiểm duyệt (Rekognition) — tin đăng bắt buộc có ảnh."""
    raw = b''.join(b'\x00' + b'\x80\x80\x80' * 64 for _ in range(64))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b'')
    _, t = call('POST', '/uploads/presign', user, {'contentType': 'image/png'})
    crlf, b = '\r\n', '----' + uuid.uuid4().hex
    parts = [f'--{b}{crlf}Content-Disposition: form-data; name="{k}"{crlf}{crlf}{v}{crlf}'.encode() for k, v in t['fields'].items()]
    parts.append(f'--{b}{crlf}Content-Disposition: form-data; name="file"; filename="a.png"{crlf}Content-Type: image/png{crlf}{crlf}'.encode() + png + crlf.encode())
    parts.append(f'--{b}--{crlf}'.encode())
    req = urllib.request.Request(t['url'], data=b''.join(parts), headers={'Content-Type': 'multipart/form-data; boundary=' + b}, method='POST')
    urllib.request.urlopen(req)
    s, r = call('POST', '/uploads/moderate', user, {'key': t['key']})
    check('upload + moderate image (Rekognition)', s == 200 and r['allowed'], r)
    return t['key']

def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond:
        check.failed = True
check.failed = False

terms = call('GET', '/me', OWNER)[1]['currentTermsVersion']
for u in (OWNER, PARTNER, f'smoke-buyer-{RUN}'):  # khách mua cũng phải đồng ý điều khoản mới chốt được (QĐ-28)
    call('POST', '/me/accept-terms', u, {'version': terms})
s, b = call('POST', '/partners/apply', PARTNER, {'tier': 'BUSINESS', 'businessType': 'ENTERPRISE', 'businessName': f'[TEST] Smoke {RUN}',
                                                   'licenseNo': '0000000000', 'contactEmail': f'smoke-{RUN}@example.com'})
check('apply partner (tier 2)', s == 200, b)
s, br = call('POST', '/partners/me/branches', PARTNER, {
    'name': '[TEST] Chi nhánh', 'location': {**SEA, 'address': 'test'}, 'radiusKm': 5,
    'categories': ['LAPTOP'], 'conditions': ['NOT_WORKING'], 'handoverMethods': ['DROP_OFF']})
check('add branch', s == 201, br)
s, b = call('POST', '/partners/me/rules', PARTNER, {'branchId': br['branchId'], 'category': 'LAPTOP', 'conditions': ['NOT_WORKING'],
                                                    'unit': 'PER_DEVICE', 'minPrice': 100000, 'maxPrice': 200000})
check('add rule', s == 201, b)
s, b = call('GET', '/admin/partners', ADMIN, groups=['Admins'])
check('admin pending queue (GSI1 status)', s == 200 and any(p['partnerId'] == PARTNER for p in b['items']), b)
s, b = call('POST', f'/admin/partners/{PARTNER}/review', ADMIN, {'approve': True}, groups=['Admins'])
check('approve partner', s == 200 and b['status'] == 'APPROVED', b)

# Chỉ đối tác đã duyệt mới đăng tin (QĐ-34): người bán đăng ký cấp 1
s, b = call('POST', '/listings', OWNER, {}, idem=True)
check('non-partner cannot post', s == 403 and b['code'] == 'PARTNER_REQUIRED', b)
s, b = call('POST', '/partners/apply', OWNER, {'tier': 'INDIVIDUAL', 'businessType': 'PERSONAL', 'businessName': f'[TEST] Seller {RUN}', 'licenseNo': '000000000000', 'contactEmail': f'seller-{RUN}@example.com'})
check('apply partner (tier 1, personal)', s == 200 and b['tier'] == 'INDIVIDUAL', b)
s, b = call('POST', f'/admin/partners/{OWNER}/review', ADMIN, {'approve': True}, groups=['Admins'])
check('approve tier-1 partner without branch', s == 200 and b['status'] == 'APPROVED', b)

IMG = upload_png(OWNER)
s, lst = call('POST', '/listings', OWNER, {
    'title': '[TEST] smoke laptop', 'category': 'LAPTOP', 'condition': 'NOT_WORKING', 'unit': 'PER_DEVICE', 'quantity': 1, 'description': 'smoke test cleanup',
    'handoverMethods': ['DROP_OFF'], 'location': {'lat': SEA['lat'] + 0.01, 'lng': SEA['lng'], 'address': 'test'}, 'area': 'Test',
    'imageKeys': [IMG]}, idem=True)
check('create listing + matching (GSI1 geo)', s == 201 and lst['matchCount'] >= 1 and lst['quoteCount'] >= 1, lst)
lid = lst.get('listingId')
BUYER = f'smoke-buyer-{RUN}'
s, feed = call('GET', '/feed', BUYER)
check('feed shows new listing (public, no location, partner contact)', s == 200 and any(i['listing']['listingId'] == lid and 'location' not in i['listing'] and i['seller']['contact']['email'] == f'seller-{RUN}@example.com' for i in feed['items']), feed)
s, bconv = call('POST', f'/listings/{lid}/conversations', BUYER, {})
check('any buyer can message seller from feed', s == 200 and bconv['ownerId'] == OWNER, bconv)
s, b = call('GET', '/listings/mine', OWNER)
check('my listings (GSI1 owner)', s == 200 and b['items'] and b['items'][0]['listingId'] == lid, b)
s, b = call('GET', '/partners/me/requests', PARTNER)
check('partner requests', s == 200 and len(b['items']) == 1, b)
s, conv = call('POST', f'/listings/{lid}/conversations', PARTNER, {})
check('open chat (partner)', s == 200 and conv['ownerId'] == OWNER, conv)
cid = conv['conversationId']
call('POST', f'/conversations/{cid}/messages', PARTNER, {'text': 'Máy còn sạc không?'})
s, m = call('POST', f'/conversations/{cid}/messages', OWNER, {'text': 'Còn nhé'})
check('send chat messages', s == 201, m)
s, msgs = call('GET', f'/conversations/{cid}/messages', OWNER)
check('read chat in order', s == 200 and [x['text'] for x in msgs['items']] == ['Máy còn sạc không?', 'Còn nhé'], msgs)
s, d = call('GET', f'/listings/{lid}', OWNER)
qid = next(q['quoteId'] for q in d['quotes'] if q['partnerId'] == PARTNER)  # có thể còn đối tác test khác trong vùng
call('POST', f'/listings/{lid}/quotes/{qid}/request-confirmation', OWNER)
s, b = call('POST', f'/listings/{lid}/quotes/{qid}/confirm', PARTNER, {'price': 150000})
check('confirm quote', s == 200 and b['status'] == 'CONFIRMED_OFFER', b)
s, tx = call('POST', '/transactions', OWNER, {'listingId': lid, 'quoteId': qid}, idem=True)
check('select offer -> transaction', s == 201 and tx['status'] == 'HANDOVER_PENDING', tx)
# QĐ-38: hủy = yêu cầu hủy (tự hủy sau 5 phút); bên kia "Đồng ý hủy ngay" → hủy luôn, tin mở lại
s, b = call('POST', f"/transactions/{tx['transactionId']}/cancel", OWNER, {'reason': 'smoke test cleanup'})
check('request cancel (5-minute delay)', s == 200 and b['status'] == 'HANDOVER_PENDING' and b.get('cancelRequest'), b)
s, b = call('POST', f"/transactions/{tx['transactionId']}/cancel/confirm", PARTNER)
s2, d = call('GET', f'/listings/{lid}', OWNER)
check('counterpart confirms cancel -> listing reopens', s == 200 and b['status'] == 'CANCELLED' and d['listing']['status'] == 'ACTIVE', [b, d.get('listing', {}).get('status')])
# QĐ-38: khách ra giá trong chat → người bán chấp nhận → giao dịch; hủy lại để dọn
s, offer = call('POST', f"/conversations/{bconv['conversationId']}/offers", BUYER, {'price': 120000})
check('buyer price offer in chat', s == 201 and offer.get('kind') == 'OFFER', offer)
s, deal = call('POST', f"/conversations/{bconv['conversationId']}/offers/{offer['offerId']}/accept", OWNER, idem=True)
check('seller accepts offer -> transaction', s == 200 and deal.get('transactionId'), deal)
call('POST', f"/transactions/{deal['transactionId']}/cancel", BUYER, {'reason': 'smoke test cleanup'})
s, b = call('POST', f"/transactions/{deal['transactionId']}/cancel/confirm", OWNER)
check('cancel chat deal', s == 200 and b['status'] == 'CANCELLED', b)
s, b = call('GET', '/notifications/unread-count', PARTNER)
check('notifications', s == 200 and b['count'] >= 3, b)

# B6 (get.md): giao dịch đi tới HOÀN TẤT → phí 10.000đ, tin COMPLETED, đánh giá; GSI1 TX#STATUS# đổi theo (K1)
AD = dict(groups=['Admins'])
s, offer = call('POST', f"/conversations/{bconv['conversationId']}/offers", BUYER, {'price': 130000})
s, deal = call('POST', f"/conversations/{bconv['conversationId']}/offers/{offer['offerId']}/accept", OWNER, idem=True)
txid = deal.get('transactionId')
s, b = call('GET', '/admin/transactions?status=HANDOVER_PENDING', ADMIN, **AD)
check('admin: transaction listed by status (GSI1 TX#STATUS#)', s == 200 and any(t['transactionId'] == txid for t in b['items']), b)
s, b = call('POST', f'/transactions/{txid}/confirm-completion', OWNER, {'finalPrice': 130000})
check('seller confirms final price', s == 200 and b['status'] == 'AWAITING_COUNTERPARTY', b)
s, b = call('POST', f'/transactions/{txid}/confirm-completion', BUYER, {})
check('buyer accepts -> COMPLETED', s == 200 and b['status'] == 'COMPLETED' and b['finalPrice'] == 130000, b)
s, d = call('GET', f'/listings/{lid}', OWNER)
check('listing COMPLETED', s == 200 and d['listing']['status'] == 'COMPLETED', d.get('listing', {}).get('status'))
s, bill = call('GET', '/billing/me', OWNER)
check('fee line 10.000đ for seller', s == 200 and any(l['transactionId'] == txid and l['amount'] == 10000 for l in bill['currentMonth']['lines']), bill.get('currentMonth'))
s, b = call('POST', f'/transactions/{txid}/review', BUYER, {'rating': 5, 'comment': 'smoke'})
check('buyer reviews seller', s == 201, b)
s, b = call('GET', '/admin/transactions?status=COMPLETED', ADMIN, **AD)
check('admin: completed transaction moved to COMPLETED', s == 200 and any(t['transactionId'] == txid for t in b['items']), b)

# B6: nhánh TRANH CHẤP → Admin kết luận thất bại → tin mở lại
IMG2 = upload_png(OWNER)
s, lst2 = call('POST', '/listings', OWNER, {
    'title': '[TEST] smoke dispute', 'category': 'LAPTOP', 'condition': 'NOT_WORKING', 'unit': 'PER_DEVICE', 'quantity': 1, 'description': 'smoke test dispute',
    'handoverMethods': ['DROP_OFF'], 'location': {'lat': SEA['lat'] + 0.01, 'lng': SEA['lng'], 'address': 'test'}, 'area': 'Test', 'imageKeys': [IMG2]}, idem=True)
lid2 = lst2.get('listingId')
s, c2 = call('POST', f'/listings/{lid2}/conversations', BUYER, {})
s, offer = call('POST', f"/conversations/{c2['conversationId']}/offers", BUYER, {'price': 90000})
s, deal = call('POST', f"/conversations/{c2['conversationId']}/offers/{offer['offerId']}/accept", OWNER, idem=True)
tx2 = deal.get('transactionId')
call('POST', f'/transactions/{tx2}/confirm-completion', OWNER, {'finalPrice': 90000})
s, b = call('POST', f'/transactions/{tx2}/dispute', BUYER, {'reason': 'smoke test: giá cuối sai'})
check('buyer disputes -> DISPUTED', s == 200 and b['status'] == 'DISPUTED', b)
s, b = call('GET', '/admin/disputes', ADMIN, **AD)
check('admin dispute queue', s == 200 and any(t['transactionId'] == tx2 for t in b['items']), b)
s, b = call('POST', f'/admin/transactions/{tx2}/resolve', ADMIN, {'outcome': 'FAILED', 'note': 'smoke test'}, **AD)
s2, d = call('GET', f'/listings/{lid2}', OWNER)
check('admin resolves FAILED -> listing reopens', s == 200 and b['status'] == 'FAILED' and d['listing']['status'] == 'ACTIVE', [b, d.get('listing', {}).get('status')])

# API trang Admin mới (get.md A1–A6)
s, b = call('GET', '/admin/audit', ADMIN, **AD)
check('admin: audit log has the resolve', s == 200 and any(e['routePath'] == '/admin/transactions/{id}/resolve' and e['params'].get('id') == tx2 for e in b['items']), b)
s, b = call('GET', f'/admin/users/{OWNER}', ADMIN, **AD)
check('admin: member detail', s == 200 and b['partner']['partnerId'] == OWNER and any(t['transactionId'] == txid for t in b['transactions']['items']), b)
s, b = call('GET', '/admin/users', ADMIN, **AD)
check('admin: member list (GSI1 ROLE#Owner)', s == 200 and isinstance(b['items'], list), b)
s, b = call('GET', '/admin/listings', ADMIN, **AD)
check('admin: listings by month', s == 200 and b['timezone'] == 'UTC', b)
s, b = call('GET', '/admin/reports?status=RESOLVED', ADMIN, **AD)
check('admin: resolved reports', s == 200 and isinstance(b['items'], list), b)
s, b = call('GET', '/admin/stats', ADMIN, **AD)
check('admin: month stats', s == 200 and b['month']['completedTransactions'] >= 1, b)

# Mặc định GIỮ dữ liệu test. --cleanup: KHÔNG gỡ tin (vừa hủy giao dịch → gỡ trong 72 giờ bị tính phí nghi bán ngoài,
# QĐ-39); tạm ngừng tài khoản test → tin tự ẩn khỏi Chợ (QĐ-40), mở lại được ở trang Admin.
if '--cleanup' in sys.argv:
    s, b = call('POST', f'/admin/partners/{PARTNER}/suspend', ADMIN, {'note': 'smoke test'}, groups=['Admins'])
    check('cleanup: suspend test partner', s == 200, b)
    s, b = call('POST', f'/admin/partners/{OWNER}/suspend', ADMIN, {'note': 'smoke test'}, groups=['Admins'])
    check('cleanup: suspend test seller', s == 200, b)
    s, feed = call('GET', '/feed', BUYER)
    check('cleanup: test listing hidden from feed', s == 200 and all(i['listing']['listingId'] != lid for i in feed['items']), feed)
else:
    print(f'Giữ dữ liệu test: tin {lid} (người bán {OWNER}) vẫn trên Chợ')
print('RUN', RUN, 'FAILED' if check.failed else 'ALL PASS')
sys.exit(1 if check.failed else 0)
