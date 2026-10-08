// websocket.h — Minimal, correct RFC 6455 WebSocket server.
//
// Browsers cannot open raw TCP sockets, so the server has to speak real
// WebSocket. This implements exactly what the game needs: the HTTP upgrade
// handshake (SHA-1 + base64 of the client key with the protocol GUID), and
// text frame encoding/decoding with masking, 16/64-bit lengths, continuation
// frames, ping/pong and close. No external dependencies, no TLS.
//
// The I/O model is the interesting part:
//
//   * Reads block (via select, see setReceiveWait) so the reader thread stays
//     simple, but the underlying socket is non-blocking.
//   * Writes never block. encodeFrame() appends to a caller-owned buffer and
//     flushPending() pushes as much of it as the kernel accepts; the rest stays
//     queued for a later tick. The game loop calls it, so a stalled client can
//     only ever lose its own frames.

#ifndef CRASHBALL_WEBSOCKET_H
#define CRASHBALL_WEBSOCKET_H

#include "net.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>

// ─── SHA-1 (RFC 3174) ──────────────────────────────────────────────
// Needed only for the WebSocket handshake.

class Sha1 {
public:
    Sha1() { reset(); }

    void reset() {
        h_[0] = 0x67452301u;
        h_[1] = 0xEFCDAB89u;
        h_[2] = 0x98BADCFEu;
        h_[3] = 0x10325476u;
        h_[4] = 0xC3D2E1F0u;
        total_ = 0;
        bufLen_ = 0;
    }

    void update(const uint8_t* data, size_t len) {
        total_ += len;
        while (len > 0) {
            size_t take = 64 - bufLen_;
            if (take > len) take = len;
            std::memcpy(buf_ + bufLen_, data, take);
            bufLen_ += take;
            data += take;
            len -= take;
            if (bufLen_ == 64) {
                process(buf_);
                bufLen_ = 0;
            }
        }
    }

    void finish(uint8_t out[20]) {
        const uint64_t bits = total_ * 8;

        const uint8_t pad = 0x80;
        update(&pad, 1);
        const uint8_t zero = 0;
        while (bufLen_ != 56) update(&zero, 1);

        uint8_t lengthBytes[8];
        for (int i = 0; i < 8; ++i) {
            lengthBytes[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
        }
        update(lengthBytes, 8);

        for (int i = 0; i < 5; ++i) {
            out[4 * i + 0] = static_cast<uint8_t>(h_[i] >> 24);
            out[4 * i + 1] = static_cast<uint8_t>(h_[i] >> 16);
            out[4 * i + 2] = static_cast<uint8_t>(h_[i] >> 8);
            out[4 * i + 3] = static_cast<uint8_t>(h_[i]);
        }
    }

private:
    uint32_t h_[5];
    uint64_t total_;
    uint8_t buf_[64];
    size_t bufLen_;

    static uint32_t rotl(uint32_t v, int n) {
        return (v << n) | (v >> (32 - n));
    }

    void process(const uint8_t* block) {
        uint32_t w[80];
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<uint32_t>(block[4 * i]) << 24) |
                   (static_cast<uint32_t>(block[4 * i + 1]) << 16) |
                   (static_cast<uint32_t>(block[4 * i + 2]) << 8) |
                   static_cast<uint32_t>(block[4 * i + 3]);
        }
        for (int i = 16; i < 80; ++i) {
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        }

        uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4];
        for (int i = 0; i < 80; ++i) {
            uint32_t f, k;
            if (i < 20) {
                f = (b & c) | (~b & d);
                k = 0x5A827999u;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ED9EBA1u;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8F1BBCDCu;   // SHA-1's third constant; not the SHA-256 one
            } else {
                f = b ^ c ^ d;
                k = 0xCA62C1D6u;
            }
            const uint32_t temp = rotl(a, 5) + f + e + k + w[i];
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = temp;
        }

        h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d; h_[4] += e;
    }
};

inline std::string base64Encode(const uint8_t* data, size_t len) {
    static const char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string out;
    out.reserve(((len + 2) / 3) * 4);

    size_t i = 0;
    for (; i + 3 <= len; i += 3) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) |
                           static_cast<uint32_t>(data[i + 2]);
        out.push_back(kTable[(v >> 18) & 63]);
        out.push_back(kTable[(v >> 12) & 63]);
        out.push_back(kTable[(v >> 6) & 63]);
        out.push_back(kTable[v & 63]);
    }

    const size_t rest = len - i;
    if (rest == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kTable[(v >> 18) & 63]);
        out.push_back(kTable[(v >> 12) & 63]);
        out += "==";
    } else if (rest == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kTable[(v >> 18) & 63]);
        out.push_back(kTable[(v >> 12) & 63]);
        out.push_back(kTable[(v >> 6) & 63]);
        out.push_back('=');
    }
    return out;
}

// sec-websocket-accept = base64(sha1(key + GUID)), RFC 6455 §4.2.2.
inline std::string computeAcceptKey(const std::string& clientKey) {
    static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const std::string source = clientKey + kGuid;

    Sha1 sha;
    sha.update(reinterpret_cast<const uint8_t*>(source.data()), source.size());
    uint8_t digest[20];
    sha.finish(digest);
    return base64Encode(digest, sizeof(digest));
}

// ─── WebSocket connection ──────────────────────────────────────────

class WebSocket {
public:
    static constexpr uint8_t kOpText = 0x1;
    static constexpr uint8_t kOpClose = 0x8;
    static constexpr uint8_t kOpPing = 0x9;
    static constexpr uint8_t kOpPong = 0xA;

    // Result of flushPending().
    enum class Flush { Done, Partial, Dead };

    WebSocket() = default;
    ~WebSocket() { close(); }

    WebSocket(const WebSocket&) = delete;
    WebSocket& operator=(const WebSocket&) = delete;

    void adopt(net::socket_t s) {
        close();
        sock_ = s;
        in_.clear();
        fragment_.clear();
    }

    bool valid() const { return sock_ != net::kInvalidSocket; }
    net::socket_t socket() const { return sock_; }

    // How long a read may wait before it gives up and reports "nothing yet".
    // kWaitForever keeps a WebSocket open for as long as the player wants.
    void setReceiveWait(int millis) { readWaitMs_ = millis; }

    /**
     * Espera troceada con un límite total.
     *
     * Es lo que hace que apagar el servidor sea rápido. Cerrar un socket desde
     * otro hilo NO despierta a un select() que ya está esperando en él, así que
     * un hilo lector con espera larga se queda ahí colgado tras el Ctrl+C: el
     * proceso no termina hasta que la espera expira sola. Con la espera
     * troceada, el hilo vuelve al bucle cada `sliceMs`, comprueba la bandera de
     * parada y sale.
     *
     * `totalMs` es el máximo que se admite en total; 0 significa "sin límite".
     * Se usa para las conexiones HTTP keep-alive, que si no retardarían el
     * apagado quince segundos.
     */
    void setReadSlices(int sliceMs, int totalMs) {
        readWaitMs_ = sliceMs;
        readBudgetMs_ = totalMs;
        readStartMs_ = nowMs();
    }

    /** Espera restante; el hilo lector la usa para no pasarse del total. */
    int remainingReadMs() const {
        if (readBudgetMs_ <= 0) return readWaitMs_;
        const int64_t left = readBudgetMs_ - (nowMs() - readStartMs_);
        return left <= 0 ? 0 : static_cast<int>(left);
    }

    /**
     * True si la última recvText() terminó por espera, no porque el peer
     * cortara la conexión.
     *
     * Hace falta porque el hilo lector no puede quedarse esperando para
     * siempre: cerrar el socket desde otro hilo no despierta al select() en
     * curso. Con espera troceada cada vuelta mira la bandera de parada y el
     * hilo sale solo.
     */
    bool lastReadTimedOut() const { return readTimedOut_; }

    /**
     * Contador de tráfico entrante. Sube con cada recv() con éxito, Includes
     * pong y ping, no solo texto.
     *
     * Hace falta porque recvText() se queda bloqueado dentro del socket
     * consumiendo tramas de control: un cliente que solo contesta pings nunca
     * "sale" de recvText, así que el hilo de lectura no puede marcarlo como
     * activo. Con este contador el keepalive puede distinguir "callado pero
     * vivo" de "zombi" sin depender de que el jugador pulse nada.
     */
    unsigned long long activity() const {
        return activity_.load(std::memory_order_relaxed);
    }

    // ─── HTTP upgrade ──────────────────────────────────────────────

    // Blocks until one complete HTTP request header block has arrived. Any
    // bytes that follow it stay buffered (a client may pipeline its first
    // WebSocket frame right behind the upgrade request).
    bool readRequestHeader(std::string& header) {
        if (!valid()) return false;
        size_t headerEnd;
        while ((headerEnd = in_.find("\r\n\r\n")) == std::string::npos) {
            if (in_.size() > kMaxHeaderBytes) return false;
            if (!fill()) return false;
        }
        header = in_.substr(0, headerEnd);
        in_.erase(0, headerEnd + 4);
        return true;
    }

    // Builds the 101 response into `out`. Returns false (and writes a 400 into
    // `out`) when the request is not a valid upgrade.
    bool handshakeResponse(const std::string& header, std::string& out) {
        const std::string key = headerValue(header, "sec-websocket-key");
        if (key.empty()) {
            out =
                "HTTP/1.1 400 Bad Request\r\n"
                "Connection: close\r\n"
                "Content-Length: 0\r\n\r\n";
            return false;
        }

        out =
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + computeAcceptKey(key) + "\r\n\r\n";
        return true;
    }

    // Case-insensitive lookup of a single header in a raw request header block.
    static std::string headerValue(const std::string& header,
                                   const std::string& lowerName) {
        size_t lineStart = header.find("\r\n");
        if (lineStart == std::string::npos) return std::string();
        lineStart += 2;  // skip the request line

        while (lineStart < header.size()) {
            size_t lineEnd = header.find("\r\n", lineStart);
            if (lineEnd == std::string::npos) lineEnd = header.size();

            const std::string line = header.substr(lineStart, lineEnd - lineStart);
            const size_t colon = line.find(':');
            if (colon != std::string::npos) {
                std::string name = line.substr(0, colon);
                for (char& c : name) {
                    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
                }
                if (name == lowerName) {
                    size_t valueStart = colon + 1;
                    while (valueStart < line.size() &&
                           (line[valueStart] == ' ' || line[valueStart] == '\t')) {
                        ++valueStart;
                    }
                    size_t valueEnd = line.size();
                    while (valueEnd > valueStart &&
                           (line[valueEnd - 1] == ' ' || line[valueEnd - 1] == '\t')) {
                        --valueEnd;
                    }
                    return line.substr(valueStart, valueEnd - valueStart);
                }
            }
            lineStart = lineEnd + 2;
        }
        return std::string();
    }

    // ─── Framing (pure: no syscalls) ───────────────────────────────

    // Appends one server->client frame. Server frames are never masked, per
    // RFC 6455 §5.1.
    static void encodeFrame(uint8_t opcode, const std::string& payload,
                            std::string& out) {
        const size_t len = payload.size();
        out.push_back(static_cast<char>(0x80 | opcode));  // FIN + opcode

        if (len < 126) {
            out.push_back(static_cast<char>(len));
        } else if (len <= 0xFFFF) {
            out.push_back(static_cast<char>(126));
            out.push_back(static_cast<char>((len >> 8) & 0xFF));
            out.push_back(static_cast<char>(len & 0xFF));
        } else {
            out.push_back(static_cast<char>(127));
            for (int i = 7; i >= 0; --i) {
                out.push_back(
                    static_cast<char>((static_cast<uint64_t>(len) >> (8 * i)) & 0xFF));
            }
        }
        out.append(payload);
    }

    static void encodeText(const std::string& payload, std::string& out) {
        encodeFrame(kOpText, payload, out);
    }

    static void encodeClose(uint16_t code, std::string& out) {
        const char body[2] = {static_cast<char>(code >> 8),
                              static_cast<char>(code & 0xFF)};
        encodeFrame(kOpClose, std::string(body, 2), out);
    }

    // Pushes as much of `pending` as the socket will take right now, erasing
    // what went out. Never blocks.
    Flush flushPending(std::string& pending) {
        if (!valid() || pending.empty()) return Flush::Done;

        while (!pending.empty()) {
            const int chunk = pending.size() > 0x7FFFFFFF
                                  ? 0x7FFFFFFF
                                  : static_cast<int>(pending.size());
            const int sent = net::sendSome(sock_, pending.data(), chunk);
            if (sent > 0) {
                pending.erase(0, static_cast<size_t>(sent));
                continue;
            }
            if (sent < 0 && net::wouldBlock()) return Flush::Partial;
            return Flush::Dead;
        }
        return Flush::Done;
    }

    // True when the kernel has room again, i.e. a queued frame can move.
    bool canWriteNow(int millis) const {
        if (!valid()) return false;
        return net::waitWritable(sock_, millis) == 1;
    }

    // ─── Reading ───────────────────────────────────────────────────

    // Blocks until one complete text message arrives. Returns false when the
    // peer closed the connection, the read timed out, or a protocol error hit.
    bool recvText(std::string& out) {
        out.clear();
        for (;;) {
            switch (parseFrame(out)) {
                case FrameResult::Message:    return true;
                case FrameResult::Consumed:   continue;
                case FrameResult::Incomplete: if (!fill()) return false; break;
                case FrameResult::Closed:
                case FrameResult::Error:      return false;
            }
        }
    }

    void close() {
        if (sock_ != net::kInvalidSocket) {
            // shutdown() antes que close(): es lo que despierta de forma fiable
            // a un hilo lector que esté bloqueado en este socket. Cerrar sin
            // más deja el select() colgado de forma intermitente en Windows.
            net::closeSocketAndWake(sock_);
            sock_ = net::kInvalidSocket;
        }
        in_.clear();
        fragment_.clear();
    }

private:
    enum class FrameResult { Incomplete, Message, Consumed, Closed, Error };

    static constexpr size_t kMaxHeaderBytes = 16 * 1024;
    static constexpr size_t kMaxMessageBytes = 256 * 1024;

    net::socket_t sock_ = net::kInvalidSocket;
    int readWaitMs_ = net::kWaitForever;
    int readBudgetMs_ = 0;        // 0 = sin límite total
    int64_t readStartMs_ = 0;     // arranque del tramo actual
    bool readTimedOut_ = false;   // el último fill() agotó la espera
    std::atomic<unsigned long long> activity_{0};
    std::string in_;        // received but unconsumed bytes
    std::string fragment_;  // accumulates continuation frames

    // Límite actual de espera por lectura: el trozo, recortado por el total.
    int currentWaitMs() const {
        if (readWaitMs_ == net::kWaitForever) return readWaitMs_;
        const int64_t left = readBudgetMs_ > 0
            ? readBudgetMs_ - (nowMs() - readStartMs_)
            : readWaitMs_;
        return left < readWaitMs_ ? static_cast<int>(left) : readWaitMs_;
    }

    static int64_t nowMs() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::steady_clock::now().time_since_epoch())
            .count();
    }

    bool fill() {
        // The socket itself is non-blocking so that writes stay non-blocking;
        // the wait here is what makes this read block exactly like before.
        if (readWaitMs_ != 0) {
            const int ready = net::waitReadable(sock_, currentWaitMs());
            if (ready == 0) {
                // Espera agotada sin datos: no es un cierre. Se distingue para
                // que el hilo lector pueda volver a mirar la bandera de parada.
                readTimedOut_ = true;
                return false;
            }
            if (ready < 0) return false;   // el socket murió
        }

        char buf[8192];
        const int n = net::recvSome(sock_, buf, static_cast<int>(sizeof(buf)));
        if (n <= 0) {
            if (n < 0 && net::wouldBlock()) return false;
            return false;
        }
        readTimedOut_ = false;
        activity_.fetch_add(1, std::memory_order_relaxed);
        in_.append(buf, static_cast<size_t>(n));
        return true;
    }

    // Extracts one frame from `in_`, or reports that more bytes are needed.
    FrameResult parseFrame(std::string& message) {
        const size_t available = in_.size();
        if (available < 2) return FrameResult::Incomplete;

        const uint8_t b0 = static_cast<uint8_t>(in_[0]);
        const uint8_t b1 = static_cast<uint8_t>(in_[1]);
        const bool fin = (b0 & 0x80) != 0;
        const uint8_t opcode = b0 & 0x0F;
        const bool masked = (b1 & 0x80) != 0;

        uint64_t payloadLen = b1 & 0x7F;
        size_t offset = 2;

        if (payloadLen == 126) {
            if (available < offset + 2) return FrameResult::Incomplete;
            payloadLen = (static_cast<uint64_t>(static_cast<uint8_t>(in_[offset])) << 8) |
                         static_cast<uint8_t>(in_[offset + 1]);
            offset += 2;
        } else if (payloadLen == 127) {
            if (available < offset + 8) return FrameResult::Incomplete;
            payloadLen = 0;
            for (int i = 0; i < 8; ++i) {
                payloadLen = (payloadLen << 8) |
                             static_cast<uint8_t>(in_[offset + i]);
            }
            offset += 8;
        }

        if (payloadLen > kMaxMessageBytes ||
            fragment_.size() + payloadLen > kMaxMessageBytes) {
            return FrameResult::Error;
        }

        uint8_t maskKey[4] = {0, 0, 0, 0};
        if (masked) {
            if (available < offset + 4) return FrameResult::Incomplete;
            for (int i = 0; i < 4; ++i) {
                maskKey[i] = static_cast<uint8_t>(in_[offset + i]);
            }
            offset += 4;
        }

        if (available < offset + static_cast<size_t>(payloadLen)) {
            return FrameResult::Incomplete;
        }

        std::string payload = in_.substr(offset, static_cast<size_t>(payloadLen));
        in_.erase(0, offset + static_cast<size_t>(payloadLen));

        if (masked) {
            for (size_t i = 0; i < payload.size(); ++i) {
                payload[i] = static_cast<char>(
                    static_cast<uint8_t>(payload[i]) ^ maskKey[i % 4]);
            }
        }

        switch (opcode) {
            case 0x0:  // continuation of a fragmented message
                fragment_ += payload;
                if (!fin) return FrameResult::Consumed;
                message = fragment_;
                fragment_.clear();
                return FrameResult::Message;

            case 0x1:  // text
                if (fin) {
                    message = payload;
                    return FrameResult::Message;
                }
                fragment_ = payload;
                return FrameResult::Consumed;

            case 0x2:  // binary: unused by this protocol
                return FrameResult::Error;

            case 0x8:  // close
                return FrameResult::Closed;

            // Ping/pong are handled by the caller through recvPing(); anything
            // that reaches here unhandled is simply consumed.
            case 0x9:
                pendingPong_ = payload;
                return FrameResult::Consumed;

            case 0xA:
                return FrameResult::Consumed;

            default:   // reserved opcodes
                return FrameResult::Error;
        }
    }

public:
    // Non-empty when the peer sent a ping since the last call; the reply must
    // be written as a pong frame with the same payload.
    bool takePendingPong(std::string& out) {
        if (pendingPong_.empty()) return false;
        out = pendingPong_;
        pendingPong_.clear();
        return true;
    }

private:
    std::string pendingPong_;
};

#endif  // CRASHBALL_WEBSOCKET_H