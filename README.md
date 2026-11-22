# LG webOS Remote (Web App / PWA & Android)

Ứng dụng điều khiển TV LG webOS thiết kế tối ưu cho màn hình điện thoại (PWA), hỗ trợ chạy **trực tiếp trên Web (GitHub Pages)**, chạy qua **Node.js local server**, và đóng gói **Android APK**.

## 2 Chế độ chạy trên Web

### 1. Phiên bản Web trực tiếp (GitHub Pages — không cần server)
- Tự động kích hoạt khi mở từ GitHub Pages hoặc bất kỳ hosting tĩnh nào (`public/`).
- Kết nối **trực tiếp** từ trình duyệt tới TV LG qua `wss://<IP-TV>:3001` (SSAP WebSocket).
- Lưu danh sách TV gần đây & `client-key` trong `localStorage` của trình duyệt.
- Tích hợp sẵn **Chế độ Demo (TV LG ảo)** để trải nghiệm ngay không cần TV thật.
- **Lưu ý khi dùng HTTPS (GitHub Pages):** Vì TV LG dùng chứng chỉ SSL tự ký ở cổng `3001`, lần đầu kết nối hãy nhập IP TV vào tab **Quét TV** → bấm **"Mở & tin cậy chứng chỉ TV (`https://IP:3001`)"** → chọn *Nâng cao → Tiếp tục* → quay lại app bấm **Kết nối**.

### 2. Chế độ Local Server (đầy đủ SSDP quét Wi-Fi & Wake-on-LAN)
```bash
npm install
npm start
```
- Mở trên máy tính: `http://localhost:3080`
- Mở trên điện thoại (cùng Wi-Fi): Quét mã **QR** ở góc trên bên phải (hoặc truy cập `http://<IP-máy-tính>:3080`).
- Trên Chrome/Safari điện thoại: bấm **Thêm vào màn hình chính (Add to Home screen)** để dùng toàn màn hình như app.

## Tính năng chính
- **Remote đầy đủ**: D-Pad, OK, Back, Home, Exit, Settings, tăng/giảm âm lượng + thanh kéo live, Mute, chuyển kênh, Media Play/Pause/Stop/Tua, Phím số (0–9) + 4 nút màu, phím tắt YouTube / Netflix / FPT Play / Spotify.
- **Magic Touchpad (Chuột bay)**: Vuốt 1 ngón di chuột, chạm để Click, vuốt 2 ngón hoặc thanh cuộn phải để cuộn trang, chỉnh độ nhạy.
- **Bàn phím điện thoại**: Gõ chữ tiếng Việt/Anh trực tiếp vào ô tìm kiếm trên TV (YouTube, Netflix, Browser).
- **Ứng dụng & Cổng vào**: Tải danh sách ứng dụng đang cài trên TV, chuyển nhanh HDMI 1/2/3/4, gửi thông báo (Toast) và mở link web lên TV.
- **Quét TV & Wake-on-LAN** (khi chạy Local Server hoặc Android APK): Tự động quét SSDP + dải mạng `/24`, lưu MAC và bật TV từ xa.

## Tự động xuất bản lên GitHub Pages
Repo đã có sẵn workflow `.github/workflows/pages.yml`. Chỉ cần vào **Settings → Pages → Build and deployment → Source: GitHub Actions**, mỗi lần push lên `main` phiên bản Web sẽ tự động cập nhật.
