// net.h — Socket primitives (Winsock / BSD), dependency free.
//
// Split out of websocket.h so the rest of the server can talk to sockets
// without dragging in the WebSocket framing. Everything here is a thin, honest
// wrapper: no buffering, no retries, no policy.
//
// Two modes are supported per socket, and the whole server relies on the
// combination:
//
//   reads  -> select() then recv()          (blocks exactly like a blocking
//             socket, but the socket itself is non-blocking, which is what
//             lets writes be non-blocking too)
//   writes -> send() on a non-blocking socket, and the caller treats
//             "would block" as "keep the bytes queued and retry later"
//
// The point of that split: the game loop broadcasts to every client and must
// NEVER block. A client on a laptop that just went to sleep cannot be allowed
// to stall the simulation for everyone else.

#ifndef CRASHBALL_NET_H
#define CRASHBALL_NET_H

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
#  include <fcntl.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <sys/socket.h>
#  include <unistd.h>
#endif

#include <cstdint>
#include <cstring>
#include <string>

namespace net {

#ifdef _WIN32
using socket_t = SOCKET;
constexpr socket_t kInvalidSocket = INVALID_SOCKET;
#else
using socket_t = int;
constexpr socket_t kInvalidSocket = -1;
#endif

// ─── Lifecycle ─────────────────────────────────────────────────────

// Must run once before anything else here. Returns false if the platform
// stack could not be initialised.
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

/**
 * Desconecta el socket en ambos sentidos SIN liberar el mango.
 *
 * Esto es lo que despierta a un hilo que está bloqueado en recv() o select().
 * En Windows, cerrar el socket desde otro hilo mientras otro está esperando en
 * él es comportamiento indefinido: a veces devuelve y a veces se queda
 * colgado para siempre. shutdown() sí está pensado exactamente para esto, y por
 * eso el servidor lo llama antes de cerrar.
 */
inline void shutdownBoth(socket_t s) {
    if (s == kInvalidSocket) return;
#ifdef _WIN32
    ::shutdown(s, SD_BOTH);
#else
    ::shutdown(s, SHUT_RDWR);
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

/** Desconecta y cierra: la forma correcta de soltar una conexión. */
inline void closeSocketAndWake(socket_t s) {
    if (s == kInvalidSocket) return;
    shutdownBoth(s);
    closeSocket(s);
}

// ─── Errors ────────────────────────────────────────────────────────

inline int lastError() {
#ifdef _WIN32
    return WSAGetLastError();
#else
    return errno;
#endif
}

// True when a non-blocking call failed only because the socket buffer is full.
// This is a normal, expected outcome for a slow client, not an error.
inline bool wouldBlock() {
#ifdef _WIN32
    const int e = WSAGetLastError();
    return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS || e == WSAENOBUFS;
#else
    return errno == EAGAIN || errno == EWOULDBLOCK;
#endif
}

inline bool interrupted() {
#ifdef _WIN32
    return WSAGetLastError() == WSAEINTR;
#else
    return errno == EINTR;
#endif
}

// ─── Options ───────────────────────────────────────────────────────

inline void setNoDelay(socket_t s) {
    int yes = 1;
    ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY,
                 reinterpret_cast<const char*>(&yes), sizeof(yes));
}

// Puts the socket in non-blocking mode for both directions. Reads are given
// their blocking behaviour back by waiting on waitReadable() first.
inline void setNonBlocking(socket_t s, bool enable) {
#ifdef _WIN32
    u_long mode = enable ? 1u : 0u;
    ::ioctlsocket(s, FIONBIO, &mode);
#else
    int flags = ::fcntl(s, F_GETFL, 0);
    if (flags < 0) return;
    flags = enable ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
    ::fcntl(s, F_SETFL, flags);
#endif
}

// Bounds a single blocking write, used only for the HTTP path. Game traffic
// never blocks, so it does not need this.
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

// ─── I/O ───────────────────────────────────────────────────────────

inline int recvSome(socket_t s, char* buf, int len) {
#ifdef _WIN32
    return ::recv(s, buf, len, 0);
#else
    return static_cast<int>(::recv(s, buf, static_cast<size_t>(len), 0));
#endif
}

// Returns bytes written, 0 if the peer is gone, or -1 with wouldBlock() set
// when the kernel buffer is full. Callers queue the rest and retry later.
inline int sendSome(socket_t s, const char* buf, int len) {
#ifdef _WIN32
    return ::send(s, buf, len, 0);
#else
    return static_cast<int>(::send(s, buf, static_cast<size_t>(len), MSG_NOSIGNAL));
#endif
}

// ─── Listener ──────────────────────────────────────────────────────

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

// ─── Readiness ─────────────────────────────────────────────────────

constexpr int kWaitForever = -1;

// Waits until `s` is readable. Returns 1 ready, 0 timeout, -1 error.
// `millis` may be kWaitForever to block until something happens.
inline int waitReadable(socket_t s, int millis) {
    fd_set set;
    FD_ZERO(&set);
    FD_SET(s, &set);

    struct timeval timeout;
    timeout.tv_sec = (millis == kWaitForever) ? 0 : millis / 1000;
    timeout.tv_usec = (millis == kWaitForever) ? 0 : (millis % 1000) * 1000;

#ifdef _WIN32
    const int rc = ::select(0, &set, nullptr, nullptr,
                            (millis == kWaitForever) ? nullptr : &timeout);
#else
    const int rc = ::select(s + 1, &set, nullptr, nullptr,
                            (millis == kWaitForever) ? nullptr : &timeout);
#endif
    if (rc > 0) return 1;
    if (rc == 0) return 0;
    return -1;
}

// Same, for writability: used to drain a queued frame once the kernel buffer
// has room again.
inline int waitWritable(socket_t s, int millis) {
    fd_set set;
    FD_ZERO(&set);
    FD_SET(s, &set);

    struct timeval timeout;
    timeout.tv_sec = (millis == kWaitForever) ? 0 : millis / 1000;
    timeout.tv_usec = (millis == kWaitForever) ? 0 : (millis % 1000) * 1000;

#ifdef _WIN32
    const int rc = ::select(0, nullptr, &set, nullptr,
                            (millis == kWaitForever) ? nullptr : &timeout);
#else
    const int rc = ::select(s + 1, nullptr, &set, nullptr,
                            (millis == kWaitForever) ? nullptr : &timeout);
#endif
    if (rc > 0) return 1;
    if (rc == 0) return 0;
    return -1;
}

}  // namespace net

#endif  // CRASHBALL_NET_H