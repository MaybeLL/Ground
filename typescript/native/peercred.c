#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/types.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <uv.h>

static napi_value peer_uid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "a live Unix socket fd is required");
    return NULL;
  }
  uid_t uid;
#if defined(__APPLE__)
  gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0) {
#elif defined(__linux__)
  struct ucred peer;
  socklen_t length = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) != 0 ||
      length != sizeof(peer)) {
#else
  if (1) {
#endif
    napi_throw_error(env, NULL, "cannot read Unix socket peer credentials");
    return NULL;
  }
#if defined(__linux__)
  uid = peer.uid;
#endif
  napi_value value;
  if (napi_create_uint32(env, (uint32_t)uid, &value) != napi_ok) return NULL;
  return value;
}

/* Always nonblocking. Waiting callers retry in JS without occupying a libuv worker. */
static napi_value try_lock(napi_env env, napi_callback_info info) {
  napi_value argv[2], result;
  size_t argc = 2;
  int32_t fd;
  bool shared;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2
      || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0
      || napi_get_value_bool(env, argv[1], &shared) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a file descriptor and shared flag");
    return NULL;
  }
  int rc;
  do { rc = flock(fd, (shared ? LOCK_SH : LOCK_EX) | LOCK_NB); } while (rc < 0 && errno == EINTR);
  if (rc < 0) {
    const int failure = errno;
    napi_throw_error(env, failure == EWOULDBLOCK ? "EWOULDBLOCK" : uv_err_name(uv_translate_sys_error(failure)), strerror(failure));
    return NULL;
  }
  napi_get_undefined(env, &result);
  return result;
}

napi_status register_host_process(napi_env env, napi_value exports);


static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "peerUid", NAPI_AUTO_LENGTH, peer_uid, NULL,
                           &function) != napi_ok ||
      napi_set_named_property(env, exports, "peerUid", function) != napi_ok)
    return NULL;
  if (napi_create_function(env, "tryLock", NAPI_AUTO_LENGTH, try_lock, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "tryLock", function) != napi_ok) return NULL;
  if (register_host_process(env, exports) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
