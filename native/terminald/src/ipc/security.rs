//! Restrict the control and frame pipes to the account running the service.
//!
//! A named pipe created without an explicit security descriptor does not fall
//! back to the process token's default DACL. Windows gives it a permissive
//! default instead, observed on Windows 11 as:
//!
//! ```text
//! D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)
//! ```
//!
//! `WD` is Everyone and `AN` is Anonymous, both granted read. This module
//! replaces that with a protected DACL naming only the account that publishes
//! the pipes, which is the boundary the runtime directory already gives the
//! Unix sockets.

use std::{ffi::c_void, io, mem::size_of, ptr};

use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

/// Security attributes granting the service's own account full access to a pipe
/// and granting nobody else anything.
///
/// The descriptor must outlive every `CreateNamedPipe` call that uses it, so
/// the listener keeps one of these for as long as it can create instances.
pub struct CurrentUserOnly {
    descriptor: *mut c_void,
    attributes: SECURITY_ATTRIBUTES,
}

impl CurrentUserOnly {
    pub fn new() -> io::Result<Self> {
        let sid = current_user_sid()?;
        // `D:P` is a protected DACL, so no inherited entry can widen it. `GA` is
        // GENERIC_ALL, granted to the single account named by its SID.
        let sddl = encode_wide(&format!("D:P(A;;GA;;;{sid})"));
        let mut descriptor: *mut c_void = ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated and outlives the call, and
        // `descriptor` is a valid out-pointer. A null size pointer is allowed.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                // Child processes must not inherit a handle to either channel.
                bInheritHandle: 0,
            },
        })
    }

    /// Pointer for `create_with_security_attributes_raw`, valid while borrowed.
    pub fn as_raw(&mut self) -> *mut c_void {
        ptr::addr_of_mut!(self.attributes).cast()
    }
}

// SAFETY: the descriptor is a plain LocalAlloc allocation owned solely by this
// value, and Win32 ties neither it nor SECURITY_ATTRIBUTES to a thread. Moving
// one to the task that accepts connections is therefore sound.
unsafe impl Send for CurrentUserOnly {}

impl Drop for CurrentUserOnly {
    fn drop(&mut self) {
        // SAFETY: `descriptor` came from
        // ConvertStringSecurityDescriptorToSecurityDescriptorW, which documents
        // LocalFree as its release call, and is released exactly once here.
        unsafe { LocalFree(self.descriptor as HLOCAL) };
    }
}

/// A process token handle closed when it goes out of scope.
struct OwnedToken(HANDLE);

impl Drop for OwnedToken {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a token opened by `OpenProcessToken` and is
        // closed exactly once here.
        unsafe { CloseHandle(self.0) };
    }
}

/// The SDDL form of the SID that owns this process.
pub(super) fn current_user_sid() -> io::Result<String> {
    let mut raw_token: HANDLE = 0;
    // SAFETY: `raw_token` is a valid out-pointer. `GetCurrentProcess` returns a
    // pseudo-handle that needs no release.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedToken(raw_token);

    let mut needed = 0_u32;
    // SAFETY: querying with a null buffer is the documented way to learn the
    // required size. This call is expected to fail with the size written out.
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }

    // TOKEN_USER holds a pointer, so the buffer has to be pointer-aligned; a
    // Vec<u8> would only guarantee byte alignment.
    let mut buffer = vec![0_u64; (needed as usize).div_ceil(size_of::<u64>()).max(1)];
    // SAFETY: the buffer is at least `needed` bytes, the size just requested.
    let queried = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if queried == 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: on success the buffer holds a TOKEN_USER whose SID points into it.
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    let mut raw_sid = ptr::null_mut();
    // SAFETY: `user.User.Sid` is a valid SID for the lifetime of `buffer`.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut raw_sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success `raw_sid` is a NUL-terminated UTF-16 string that this
    // call now owns and releases with LocalFree.
    let sid = unsafe { decode_wide(raw_sid) };
    unsafe { LocalFree(raw_sid as HLOCAL) };
    Ok(sid)
}

fn encode_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// # Safety
///
/// `raw` must point to a NUL-terminated UTF-16 string.
unsafe fn decode_wide(raw: *mut u16) -> String {
    let mut length = 0;
    // SAFETY: the caller guarantees a NUL terminator bounds this walk.
    while unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: `length` units precede the terminator found above.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(raw, length) })
}

/// The DACL a live pipe handle actually carries, in SDDL form.
///
/// Only tests need this: it is how they confirm the descriptor built here
/// reached the object, rather than trusting that it was passed correctly.
#[cfg(test)]
pub fn dacl_of(handle: HANDLE) -> io::Result<String> {
    use windows_sys::Win32::Security::{
        Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
        },
        DACL_SECURITY_INFORMATION,
    };

    let mut descriptor = ptr::null_mut();
    // SAFETY: `handle` is a live kernel object and every unused out-parameter
    // is allowed to be null.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }

    let mut raw = ptr::null_mut();
    // SAFETY: `descriptor` is the self-relative descriptor just returned.
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut raw,
            ptr::null_mut(),
        )
    };
    if converted == 0 {
        let error = io::Error::last_os_error();
        // SAFETY: GetSecurityInfo allocates the descriptor with LocalAlloc.
        unsafe { LocalFree(descriptor as HLOCAL) };
        return Err(error);
    }
    // SAFETY: on success `raw` is a NUL-terminated UTF-16 string we now own.
    let sddl = unsafe { decode_wide(raw) };
    // SAFETY: both allocations are released exactly once.
    unsafe {
        LocalFree(raw as HLOCAL);
        LocalFree(descriptor as HLOCAL);
    }
    Ok(sddl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_owning_account_as_a_sid() {
        let sid = current_user_sid().unwrap();
        // A user SID is `S-1-5-21-<domain>-<rid>`; assert the shape rather than
        // a value that differs on every machine.
        assert!(sid.starts_with("S-1-"), "{sid}");
        assert!(sid.split('-').count() >= 4, "{sid}");
    }

    #[test]
    fn builds_security_attributes_from_that_sid() {
        let mut security = CurrentUserOnly::new().unwrap();
        assert!(!security.descriptor.is_null());
        assert!(!security.as_raw().is_null());
        assert_eq!(
            security.attributes.nLength as usize,
            size_of::<SECURITY_ATTRIBUTES>()
        );
        // A pipe handle must never reach a spawned child.
        assert_eq!(security.attributes.bInheritHandle, 0);
    }
}
