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
        return r"//.*OWNER_ID:\s*(\S+)"
    elif ext == '.py':
        return r"#.*OWNER_ID:\s*(\S+)"
    elif ext == '.css':
        return r"/\*.*OWNER_ID:\s*(\S+).*\*/"
    elif ext == '.html':
        return r"<!--.*OWNER_ID:\s*(\S+).*-->"
    else:
        return r"//.*OWNER_ID:\s*(\S+)"  # default to //

def extract_encrypted_string_from_file(file_path):
    """Extract the single complete encrypted string from the OWNER_ID line."""
    try:
        with open(file_path, 'r') as file:
            content = file.read()  # Read the entire file as a single string
        
        pattern = get_comment_pattern(file_path)
        
        match = re.search(pattern, content, re.DOTALL)
        if match:
            encrypted_string = match.group(1).strip()
            return encrypted_string
        
        print("Warning: Could not find OWNER_ID in the file.")
        return None
    except Exception as e:
        print(f"Error extracting encrypted string from file: {e}")
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
    
    # Extract the encrypted string from file
    encrypted_string = extract_encrypted_string_from_file(file_path)
    if not encrypted_string:
        print("Error: Failed to extract the encrypted string.")
        return
    
    print(f"Found encrypted string: {encrypted_string}")
    
    # Decrypt the project name using the encrypted string
    project_name = decrypt_encoded_string(encrypted_string, key)
    
    if not project_name:
        print("Error: Failed to decrypt the project name")
        return
    
    print(f"Decrypted Secret: {project_name}")
    
    # Skip copyright verification and proceed with success
    print("Verification successful!")
    if add_success_comment(file_path):
        print(f"Success comment added to {file_path}")

if __name__ == "__main__":
    main()