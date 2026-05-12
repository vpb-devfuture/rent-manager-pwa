# Rent Manager PWA — chạy trên iPhone không cần Mac

Bản này được chuyển từ Chrome Extension sang Progressive Web App (PWA). UI và logic nghiệp vụ chính được giữ lại; phần phụ thuộc Chrome Extension đã được thay bằng Web API.

## 1. Các phần đã convert

- `chrome.storage.local` → `localStorage` thông qua `lib/platform.js`.
- `chrome.identity` → Google Identity Services trong `lib/auth.js`.
- `chrome.runtime.getURL()` → URL tương đối của web app.
- `chrome.notifications` → Web Notification API nếu trình duyệt hỗ trợ.
- Thêm `manifest.webmanifest`, `service-worker.js`, `bootstrap.js` để cài được như PWA.
- Giữ lại Google Drive sync, import Excel, OCR ảnh đồng hồ, sharing code.

## 2. Các file quan trọng

```text
index.html                 # entry point PWA
app.html                   # giữ lại để tương thích link cũ
bootstrap.js               # nạp compatibility layer + đăng ký service worker
config.local.js            # cấu hình OAuth/API key hiện tại
config.local.example.js    # file mẫu cấu hình
manifest.webmanifest       # PWA manifest
service-worker.js          # cache app shell
lib/platform.js            # shim chrome.* cho browser/PWA
lib/auth.js                # Google OAuth cho PWA
```

## 3. Chạy local trên máy tính

Không mở trực tiếp bằng `file://`, vì PWA/OAuth cần chạy qua HTTP/HTTPS.

```bash
cd rent-manager-pwa
python -m http.server 5173
```

Sau đó mở:

```text
http://localhost:5173
```

## 4. Cấu hình Google OAuth cho PWA

Vào Google Cloud Console → APIs & Services → Credentials → OAuth Client.

Nên dùng OAuth Client loại **Web application**. Trong phần **Authorized JavaScript origins**, thêm origin anh dùng để chạy app:

```text
http://localhost:5173
https://<domain-deploy-cua-anh>
```

Ví dụ nếu deploy lên Vercel:

```text
https://rent-manager-abc.vercel.app
```

File `config.local.js` hiện đã lấy lại `client_id` và API keys từ extension gốc. Nếu anh tạo OAuth Client mới thì sửa lại:

```js
window.RENT_MANAGER_CONFIG = {
  google_client_id: 'YOUR_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com',
  drive_api_key: 'YOUR_GOOGLE_DRIVE_API_KEY',
  gemini_api_key: 'YOUR_GEMINI_API_KEY_OPTIONAL'
};
```

## 5. Deploy miễn phí để iPhone truy cập

Cách đơn giản nhất là dùng Vercel hoặc Netlify.

### Vercel

1. Tạo GitHub repo, commit toàn bộ folder PWA.
2. Vào Vercel → New Project → Import repo.
3. Framework chọn **Other** hoặc để auto.
4. Build command để trống.
5. Output directory để `.` nếu repo chỉ chứa folder PWA; nếu repo chứa nhiều folder thì chọn đúng folder.
6. Deploy.
7. Copy domain `https://...vercel.app`.
8. Thêm domain này vào Google OAuth Authorized JavaScript origins.

### Netlify

1. Vào Netlify → Add new site → Deploy manually.
2. Kéo thả folder PWA vào Netlify.
3. Copy domain `https://...netlify.app`.
4. Thêm domain này vào Google OAuth Authorized JavaScript origins.

## 6. Cài lên iPhone

1. Mở link HTTPS bằng **Safari** trên iPhone.
2. Bấm nút **Share**.
3. Chọn **Add to Home Screen**.
4. Đặt tên `Rent Manager`.
5. Mở icon ngoài màn hình chính.
6. Bấm **Đăng nhập với Google**.

## 7. Lưu ý quan trọng

- PWA không thể hoạt động như Chrome Extension desktop để inject vào website khác. App này không phụ thuộc content script nên hướng PWA phù hợp.
- API key trong frontend luôn có thể bị xem bởi người dùng. Nên restrict API key theo HTTP referrer trong Google Cloud Console trước khi public rộng.
- Google token trên web có thể hết hạn. Khi sync Drive báo lỗi auth, bấm đăng nhập/sync lại.
- Web Notification trên iPhone có thể bị giới hạn tùy iOS/Safari và thường chỉ ổn sau khi app được Add to Home Screen.
- `localStorage` có quota thấp hơn `chrome.storage.local`; app đã bỏ cache ảnh base64 nên vẫn ổn cho dữ liệu thông thường.
