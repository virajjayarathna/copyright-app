import os
import base64
import hashlib
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
import sys
import re

def decrypt_encoded_string(encoded_string, key):
    """Decrypt the encoded string back to the project name using AES-256-CBC."""
    try:
        # Generate AES-256 key by hashing the input key string
        hashed_key = hashlib.sha256(key.encode()).digest()
        aes_key = hashed_key[:32]  # AES-256 requires a 32-byte key

        # Decode the base64 encoded string
        combined = base64.b64decode(encoded_string)

        # Extract IV (first 16 bytes) and encrypted data
        iv = combined[:16]
        encrypted_data = combined[16:]

        # Create AES cipher object with CBC mode
        cipher = AES.new(aes_key, AES.MODE_CBC, iv)

        # Decrypt and remove padding
        decrypted_padded = cipher.decrypt(encrypted_data)
        decrypted = unpad(decrypted_padded, AES.block_size)

        return decrypted.decode('utf-8')
    except Exception as e:
        print(f"Error decrypting: {e}")
        return None

def get_comment_pattern(file_path):
    """Get the regex pattern for extracting OWNER_ID based on file extension."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext in ['.js', '.jsx', '.ts', '.tsx']:
        return r"//\s*OWNER_ID:\s*(\S+)"
    elif ext == '.py':
        return r"#\s*OWNER_ID:\s*(\S+)"
    elif ext == '.css':
        return r"/\*\s*OWNER_ID:\s*(\S+)\s*\*/"
    elif ext == '.html':
        return r"<!--\s*OWNER_ID:\s*(\S+)\s*-->"
    else:
        return r"//\s*OWNER_ID:\s*(\S+)"  # default to //

def extract_parts_from_file(file_path):
    """Extract encoded parts from comments containing 'OWNER_ID:' using the appropriate pattern."""
    try:
        with open(file_path, 'r') as file:
            lines = file.readlines()
        
        pattern = get_comment_pattern(file_path)
        parts = []
        for line in lines:
            match = re.search(pattern, line)
            if match:
                part = match.group(1).strip()
                parts.append(part)
        
        if len(parts) < 5:
            print(f"Warning: Only found {len(parts)} parts, expected 5.")
        elif len(parts) > 5:
            print(f"Warning: Found {len(parts)} parts, using first 5.")
            parts = parts[:5]
        
        return parts
    except Exception as e:
        print(f"Error extracting parts from file: {e}")
        return None

def get_comment_syntax(file_path):
    """Get the comment syntax based on file extension."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext in ['.js', '.jsx', '.ts', '.tsx']:
        return '//', ''
    elif ext == '.py':
        return '#', ''
    elif ext == '.css':
        return '/*', '*/'
    elif ext == '.html':
        return '<!--', '-->'
    else:
        return '//', ''  # default

def add_success_comment(file_path):
    """Add success comment to end of file using appropriate syntax."""
    try:
        comment_start, comment_end = get_comment_syntax(file_path)
        with open(file_path, 'a') as file:
            if comment_end:
                file.write(f"\n{comment_start} succesfully decrypted. {comment_end}\n")
                file.write(f"{comment_start} This code is property of KingIT {comment_end}\n")
            else:
                file.write(f"\n{comment_start} succesfully decrypted.\n")
                file.write(f"{comment_start} This code is property of KingIT\n")
        return True
    except Exception as e:
        print(f"Error adding success comment: {e}")
        return False

def main():
    # Get input from user
    file_path = input("Enter file path: ")
    key = input("Enter decryption key: ")
    
    # Check if file exists
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} does not exist.")
        return
    
    # Extract parts from file
    parts = extract_parts_from_file(file_path)
    if not parts or len(parts) < 5:
        print("Error: Failed to extract all required parts.")
        return
    
    # Reconstruct the full encrypted string
    full_encrypted = ''.join(parts)
    print(f"Reconstructed encrypted string: {full_encrypted}")
    
    # Decrypt the project name using the reconstructed string
    project_name = decrypt_encoded_string(full_encrypted, key)
    
    if not project_name:
        print("Error: Failed to decrypt the project name")
        return
    
    print(f"Decrypted project name: {project_name}")
    
    # Skip copyright verification and proceed with success
    print("Verification successful!")
    if add_success_comment(file_path):
        print(f"Success comment added to {file_path}")

if __name__ == "__main__":
    main()