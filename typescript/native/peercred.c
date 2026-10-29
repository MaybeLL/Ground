#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>

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

napi_status register_safe_tree(napi_env env, napi_value exports);
napi_status register_host_process(napi_env env, napi_value exports);


static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "peerUid", NAPI_AUTO_LENGTH, peer_uid, NULL,
                           &function) != napi_ok ||
      napi_set_named_property(env, exports, "peerUid", function) != napi_ok)
    return NULL;
  if (register_safe_tree(env, exports) != napi_ok) return NULL;
  if (register_host_process(env, exports) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
