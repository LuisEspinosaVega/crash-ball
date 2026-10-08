// websocket.h — Sockets + a minimal, correct RFC 6455 WebSocket server.
//
// Browsers cannot open raw TCP sockets, so the server has to speak real
// WebSocket. This implements exactly what the game needs: the HTTP upgrade
// handshake (SHA-1 + base64 of the client key with the protocol GUID), and
// text frame encoding/decoding with masking, 16/64-bit lengths, continuation
// frames, ping/pong and close. No external dependencies, no TLS.
//
// The original code faked this: it XORed the key with a *misspelled* GUID and
// "base64"-encoded the result with a broken bit shift, which no browser would
// ever accept.

#ifndef CRASHBALL_WEBSOCKET_H
#define CRASHBALL_WEBSOCKET_H

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#else
#  include <arpa/inet.h>
#  include <cerrno>
#  include <csignal>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <sys/socket.h>
#  include <unistd.h>
#endif

#include <cstdint>
#include <cstring>
#include <string>

#ifndef MSG_NOSIGNAL
#  define MSG_NOSIGNAL 0
#endif

// ─── Socket primitives ─────────────────────────────────────────────

namespace net {

#ifdef _WIN32
using socket_t = SOCKET;
constexpr socket_t kInvalidSocket = INVALID_SOCKET;
#else
using socket_t = int;
constexpr socket_t kInvalidSocket = -1;
#endif

// Must be called once before any other socket call. Returns false if the
// platform's networking stack could not be initialised.
inline bool startup() {
#ifdef _WIN32
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
    // A client that vanishes mid-send must not kill the whole server.
    std::signal(SIGPIPE, SIG_IGN);
    return true;
#endif
}

inline void shutdown() {
#ifdef _WIN32
    WSACleanup();
#endif
}

inline void closeSocket(socket_t s) {
    if (s == kInvalidSocket) return;
#ifdef _WIN32
    ::closesocket(s);
#else
    ::close(s);
#endif
}

inline int lastError() {
#ifdef _WIN32
    return WSAGetLastError();
#else
    return errno;
#endif
}

inline int recvSome(socket_t s, char* buf, int len) {
#ifdef _WIN32
    return ::recv(s, buf, len, 0);
#else
    return static_cast<int>(::recv(s, buf, static_cast<size_t>(len), 0));
#endif
}

inline int sendSome(socket_t s, const char* buf, int len) {
#ifdef _WIN32
    return ::send(s, buf, len, 0);
#else
    return static_cast<int>(::send(s, buf, static_cast<size_t>(len), MSG_NOSIGNAL));
#endif
}

inline void setNoDelay(socket_t s) {
    int yes = 1;
    ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY,
                 reinterpret_cast<const char*>(&yes), sizeof(yes));
}

// Bounds how long a single send can block, so one unresponsive client cannot
// stall the shared game loop that is broadcasting to everybody.
inline void setSendTimeout(socket_t s, int millis) {
#ifdef _WIN32
    DWORD timeout = static_cast<DWORD>(millis);
#else
    struct timeval timeout;
    timeout.tv_sec = millis / 1000;
    timeout.tv_usec = (millis % 1000) * 1000;
#endif
    ::setsockopt(s, SOL_SOCKET, SO_SNDTIMEO,
                 reinterpret_cast<const char*>(&timeout), sizeof(timeout));
}

// Creates a listening socket on `port`. Prefers a dual-stack IPv6 socket so
// that both "localhost" (::1) and 127.0.0.1 reach us, and falls back to IPv4.
inline socket_t listenTcp(uint16_t port, int backlog, std::string& error) {
    int reuse = 1;

    socket_t s = ::socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP);
    if (s != kInvalidSocket) {
        int v6only = 0;  // also accept IPv4-mapped connections
        ::setsockopt(s, IPPROTO_IPV6, IPV6_V6ONLY,
                     reinterpret_cast<const char*>(&v6only), sizeof(v6only));
        ::setsockopt(s, SOL_SOCKET, SO_REUSEADDR,
                     reinterpret_cast<const char*>(&reuse), sizeof(reuse));

        sockaddr_in6 addr6;
        std::memset(&addr6, 0, sizeof(addr6));
        addr6.sin6_family = AF_INET6;
        addr6.sin6_addr = in6addr_any;
        addr6.sin6_port = htons(port);

        if (::bind(s, reinterpret_cast<sockaddr*>(&addr6), sizeof(addr6)) == 0 &&
            ::listen(s, backlog) == 0) {
            return s;
        }
        closeSocket(s);
    }

    s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == kInvalidSocket) {
        error = "socket() failed (error " + std::to_string(lastError()) + ")";
        return kInvalidSocket;
    }
    ::setsockopt(s, SOL_SOCKET, SO_REUSEADDR,
                 reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in addr4;
    std::memset(&addr4, 0, sizeof(addr4));
    addr4.sin_family = AF_INET;
    addr4.sin_addr.s_addr = INADDR_ANY;
    addr4.sin_port = htons(port);

    if (::bind(s, reinterpret_cast<sockaddr*>(&addr4), sizeof(addr4)) != 0 ||
        ::listen(s, backlog) != 0) {
        error = "cannot bind/listen on port " + std::to_string(port) +
                " (error " + std::to_string(lastError()) + ")";
        closeSocket(s);
        return kInvalidSocket;
    }
    return s;
}

inline socket_t acceptTcp(socket_t listener) {
    return ::accept(listener, nullptr, nullptr);
}

// Waits until `s` has bytes to read. Returns 1 when ready, 0 on timeout and
// -1 on error. Used so the accept loop can poll a shutdown flag instead of
// blocking forever inside accept().
inline int waitReadable(socket_t s, int millis) {
    fd_set set;
    FD_ZERO(&set);
    FD_SET(s, &set);

    struct timeval timeout;
    timeout.tv_sec = millis / 1000;
    timeout.tv_usec = (millis % 1000) * 1000;

#ifdef _WIN32
    const int rc = ::select(0, &set, nullptr, nullptr, &timeout);
#else
    const int rc = ::select(s + 1, &set, nullptr, nullptr, &timeout);
#endif
    if (rc > 0) return 1;
    if (rc == 0) return 0;
    return -1;
}

}  // namespace net

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
                k = 0x8F1BBCDCu;
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

    // Answers the upgrade request with 101 Switching Protocols.
    bool acceptHandshake(const std::string& header) {
        const std::string key = headerValue(header, "sec-websocket-key");
        if (key.empty()) {
            static const char kBad[] =
                "HTTP/1.1 400 Bad Request\r\n"
                "Connection: close\r\n"
                "Content-Length: 0\r\n\r\n";
            writeAll(kBad, sizeof(kBad) - 1);
            return false;
        }

        const std::string response =
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + computeAcceptKey(key) + "\r\n\r\n";
        return writeAll(response.data(), response.size());
    }

    // Raw write, used to answer plain HTTP requests.
    bool sendRaw(const std::string& bytes) {
        return writeAll(bytes.data(), bytes.size());
    }

    // Bounds how long a blocking read may wait. Used for idle HTTP
    // keep-alive connections; a timeout surfaces as a failed read.
    void setReceiveTimeout(int millis) {
        if (!valid()) return;
#ifdef _WIN32
        DWORD timeout = static_cast<DWORD>(millis);
#else
        struct timeval timeout;
        timeout.tv_sec = millis / 1000;
        timeout.tv_usec = (millis % 1000) * 1000;
#endif
        ::setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO,
                     reinterpret_cast<const char*>(&timeout), sizeof(timeout));
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

    bool sendText(const std::string& payload) {
        return sendFrame(0x1, reinterpret_cast<const uint8_t*>(payload.data()),
                         payload.size());
    }

    bool sendClose(uint16_t code = 1000) {
        const uint8_t body[2] = {static_cast<uint8_t>(code >> 8),
                                 static_cast<uint8_t>(code & 0xFF)};
        const bool ok = sendFrame(0x8, body, sizeof(body));
        // Half-close: stop reading, but let the peer's close frame arrive.
        if (sock_ != net::kInvalidSocket) {
#ifdef _WIN32
            ::shutdown(sock_, SD_SEND);
#else
            ::shutdown(sock_, SHUT_WR);
#endif
        }
        return ok;
    }

    // Blocks until one complete text message arrives. Returns false when the
    // peer closed the connection or a protocol error occurred.
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
            net::closeSocket(sock_);
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
    std::string in_;        // received but unconsumed bytes
    std::string fragment_;  // accumulates continuation frames

    bool fill() {
        char buf[8192];
        const int n = net::recvSome(sock_, buf, static_cast<int>(sizeof(buf)));
        if (n <= 0) return false;
        in_.append(buf, static_cast<size_t>(n));
        return true;
    }

    bool writeAll(const void* data, size_t len) {
        const char* cursor = static_cast<const char*>(data);
        size_t remaining = len;
        while (remaining > 0) {
            const int chunk = remaining > 0x7FFFFFFF
                                  ? 0x7FFFFFFF
                                  : static_cast<int>(remaining);
            const int sent = net::sendSome(sock_, cursor, chunk);
            if (sent <= 0) return false;
            cursor += sent;
            remaining -= static_cast<size_t>(sent);
        }
        return true;
    }

    bool sendFrame(uint8_t opcode, const uint8_t* data, size_t len) {
        if (!valid()) return false;

        std::string frame;
        frame.reserve(len + 10);
        frame.push_back(static_cast<char>(0x80 | opcode));  // FIN + opcode

        if (len < 126) {
            frame.push_back(static_cast<char>(len));
        } else if (len <= 0xFFFF) {
            frame.push_back(static_cast<char>(126));
            frame.push_back(static_cast<char>((len >> 8) & 0xFF));
            frame.push_back(static_cast<char>(len & 0xFF));
        } else {
            frame.push_back(static_cast<char>(127));
            for (int i = 7; i >= 0; --i) {
                frame.push_back(static_cast<char>(
                    (static_cast<uint64_t>(len) >> (8 * i)) & 0xFF));
            }
        }

        if (len > 0) {
            frame.append(reinterpret_cast<const char*>(data), len);
        }
        return writeAll(frame.data(), frame.size());
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
                sendClose(1000);
                return FrameResult::Closed;

            case 0x9:  // ping -> pong
                sendFrame(0xA, reinterpret_cast<const uint8_t*>(payload.data()),
                          payload.size());
                return FrameResult::Consumed;

            case 0xA:  // pong
                return FrameResult::Consumed;

            default:   // reserved opcodes
                return FrameResult::Error;
        }
    }
};

#endif  // CRASHBALL_WEBSOCKET_H
